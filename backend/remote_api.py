"""Remote RGB camera for the Synced Capture page (/thermal-sync/).

A phone opens /thermal-remote/ (QR code on the laptop) and joins the laptop's pairing session.
Both pages talk only to this server, so the phone can be on Wi-Fi or mobile data:

  laptop (host) <-- WebSocket --> server <-- WebSocket --> phone
  - the phone streams small preview JPEGs (binary messages, one in flight at a time)
  - the laptop sends "capture" with a start time in server-clock milliseconds; both devices start then
  - the phone uploads the full-quality photo/video here (POST /thermal/remote/upload); the laptop's
    /thermal/predict(_video) call names it with remote_upload instead of sending an RGB file.

Sessions live in memory (the service runs one uvicorn worker) and expire after 30 minutes idle.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import secrets
import shutil
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse
from starlette.websockets import WebSocketDisconnect, WebSocketState

logger = logging.getLogger("remote-camera")

SESSION_TTL_SEC = 30 * 60
MAX_SESSIONS = 100
MAX_SESSIONS_PER_IP = 8
MAX_UPLOADS_PER_SESSION = 6
MAX_PHOTO_BYTES = 25 * 1024 * 1024
MAX_VIDEO_BYTES = 45 * 1024 * 1024
MAX_FRAME_BYTES = 256 * 1024          # preview JPEG
MAX_TEXT_BYTES = 8 * 1024
JOIN_FAIL_LIMIT = 20                  # wrong codes per IP per window
JOIN_FAIL_WINDOW_SEC = 10 * 60
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
CODE_LENGTH = 6
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_SUFFIXES = {".webm", ".mp4", ".mov", ".m4v"}
HOST_TO_PHONE = {"capture", "cancel"}
PHONE_TO_HOST = {"status", "recording", "captured", "upload_progress", "error"}

router = APIRouter()
_staging_dir = ""


def now_ms() -> float:
    return time.time() * 1000.0


@dataclass
class Upload:
    upload_id: str
    path: str
    kind: str                # 'photo' | 'video'
    suffix: str
    mime: str
    size: int
    capture_id: str
    started_ms: Optional[float]
    ended_ms: Optional[float]
    created: float = field(default_factory=time.time)


@dataclass
class Session:
    code: str
    host_token: str
    ip: str
    created: float = field(default_factory=time.time)
    touched: float = field(default_factory=time.time)
    phone_token: Optional[str] = None
    host_ws: Optional[WebSocket] = None
    phone_ws: Optional[WebSocket] = None
    phone_info: Dict[str, Any] = field(default_factory=dict)
    uploads: Dict[str, Upload] = field(default_factory=dict)

    def touch(self) -> None:
        self.touched = time.time()

    @property
    def dir(self) -> str:
        return os.path.join(_staging_dir, self.host_token[:16])


_by_code: Dict[str, Session] = {}
_by_host: Dict[str, Session] = {}
_join_fails: Dict[str, list] = {}


# --------------------------------------------------------------------------- helpers

def _client_ip(request_or_ws) -> str:
    fwd = request_or_ws.headers.get("x-real-ip") or request_or_ws.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() or (request_or_ws.client.host if request_or_ws.client else "?"))[:64]


def _new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if code not in _by_code:
            return code


def _normalize_code(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())[:CODE_LENGTH]


def _qr_svg(text: str) -> str:
    import qrcode
    import qrcode.image.svg

    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    svg = buf.getvalue().decode("utf-8")
    return svg[svg.index("<svg"):]  # drop the XML declaration so it can be inlined


async def _send_json(ws: Optional[WebSocket], obj: Dict[str, Any]) -> bool:
    if ws is None or ws.client_state != WebSocketState.CONNECTED:
        return False
    try:
        await ws.send_text(json.dumps(obj))
        return True
    except Exception:  # peer went away mid-send
        return False


async def _close(ws: Optional[WebSocket], code: int, reason: str) -> None:
    if ws is None or ws.client_state != WebSocketState.CONNECTED:
        return
    try:
        await ws.close(code=code, reason=reason)
    except Exception:
        pass


def _phone_summary(s: Session) -> Dict[str, Any]:
    return {"connected": s.phone_ws is not None, **s.phone_info}


async def _drop_session(s: Session, reason: str) -> None:
    _by_code.pop(s.code, None)
    _by_host.pop(s.host_token, None)
    await _send_json(s.phone_ws, {"type": "session_closed", "reason": reason})
    await _close(s.phone_ws, 4410, reason)
    await _close(s.host_ws, 4410, reason)
    shutil.rmtree(s.dir, ignore_errors=True)


async def _expire_loop() -> None:
    while True:
        await asyncio.sleep(60)
        cutoff = time.time() - SESSION_TTL_SEC
        for s in list(_by_host.values()):
            live = s.host_ws is not None or s.phone_ws is not None
            if s.touched < cutoff and not live:
                await _drop_session(s, "expired")
            elif s.touched < time.time() - 4 * 3600:  # hard cap even with open sockets
                await _drop_session(s, "expired")
        for ip, fails in list(_join_fails.items()):
            fresh = [t for t in fails if t > time.time() - JOIN_FAIL_WINDOW_SEC]
            if fresh:
                _join_fails[ip] = fresh
            else:
                _join_fails.pop(ip, None)


def _remove_upload(s: Session, upload_id: str) -> None:
    up = s.uploads.pop(upload_id, None)
    if up is not None:
        try:
            os.remove(up.path)
        except OSError:
            pass


# --------------------------------------------------------------------------- used by thermal_api

def take_upload(host_token: Optional[str], upload_id: Optional[str], kind: str) -> Tuple[bytes, str, Dict[str, Any]]:
    """Bytes, suffix and metadata of a phone upload belonging to this laptop session."""
    s = _by_host.get(host_token or "")
    if s is None:
        raise HTTPException(status_code=404, detail="The phone pairing session has expired. Pair the phone again.")
    up = s.uploads.get(upload_id or "")
    if up is None or up.kind != kind:
        raise HTTPException(status_code=404, detail="The phone's file was not found. Capture again.")
    with open(up.path, "rb") as fh:
        data = fh.read()
    s.touch()
    meta = {
        "started_ms": up.started_ms, "ended_ms": up.ended_ms, "capture_id": up.capture_id,
        "device": phone_device_label(s.phone_info),
    }
    return data, up.suffix, meta


def release_upload(host_token: Optional[str], upload_id: Optional[str]) -> None:
    s = _by_host.get(host_token or "")
    if s is not None and upload_id:
        _remove_upload(s, upload_id)


def phone_device_label(info: Dict[str, Any]) -> str:
    parts = [info.get("model") or "", info.get("camera") or ""]
    return " · ".join(p for p in parts if p)[:80] or "mobile"


# --------------------------------------------------------------------------- HTTP

@router.post("/thermal/remote/session")
async def create_session(request: Request, host_token: Optional[str] = Form(None)) -> Dict[str, Any]:
    """Create (or resume, when the page reloads with its token) the laptop's pairing session."""
    s = _by_host.get(host_token or "")
    if s is None:
        ip = _client_ip(request)
        if sum(1 for x in _by_host.values() if x.ip == ip) >= MAX_SESSIONS_PER_IP:
            oldest = min((x for x in _by_host.values() if x.ip == ip), key=lambda x: x.touched)
            await _drop_session(oldest, "replaced by a newer session")
        if len(_by_host) >= MAX_SESSIONS:
            oldest = min(_by_host.values(), key=lambda x: x.touched)
            await _drop_session(oldest, "server busy")
        s = Session(code=_new_code(), host_token=secrets.token_urlsafe(32), ip=ip)
        _by_code[s.code] = s
        _by_host[s.host_token] = s
    s.touch()
    base = f"https://{request.headers.get('host', request.url.hostname)}"
    join_url = f"{base}/thermal-remote/?c={s.code}"
    return {
        "host_token": s.host_token,
        "code": s.code,
        "join_url": join_url,
        "qr_svg": _qr_svg(join_url),
        "ttl_sec": SESSION_TTL_SEC,
        "phone": _phone_summary(s),
        "server_ms": now_ms(),
    }


@router.post("/thermal/remote/upload")
async def upload(
    phone_token: str = Form(...),
    capture_id: str = Form(...),
    kind: str = Form(...),
    started_ms: Optional[float] = Form(None),
    ended_ms: Optional[float] = Form(None),
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    s = next((x for x in _by_host.values() if x.phone_token and secrets.compare_digest(x.phone_token, phone_token)), None)
    if s is None:
        raise HTTPException(status_code=403, detail="This phone is no longer paired. Scan the code again.")
    if kind not in {"photo", "video"}:
        raise HTTPException(status_code=422, detail="kind must be photo or video.")
    suffix = os.path.splitext(file.filename or "")[1].lower() or (".jpg" if kind == "photo" else ".mp4")
    allowed = PHOTO_SUFFIXES if kind == "photo" else VIDEO_SUFFIXES
    if suffix not in allowed:
        raise HTTPException(status_code=422, detail=f"Unsupported {kind} type {suffix}.")
    limit = MAX_PHOTO_BYTES if kind == "photo" else MAX_VIDEO_BYTES
    data = await file.read(limit + 1)
    if not data:
        raise HTTPException(status_code=400, detail="The file is empty.")
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"The {kind} is larger than {limit // (1024 * 1024)} MB.")
    capture_id = "".join(ch for ch in capture_id if ch.isalnum() or ch in "-_")[:64] or "capture"

    os.makedirs(s.dir, exist_ok=True)
    upload_id = f"up_{secrets.token_hex(12)}"
    path = os.path.join(s.dir, f"{upload_id}{suffix}")
    with open(path, "wb") as fh:
        fh.write(data)
    for v in (started_ms, ended_ms):
        if v is not None and not (abs(v - now_ms()) < 3_600_000):
            started_ms = ended_ms = None  # nonsense clock values
    up = Upload(upload_id, path, kind, suffix, file.content_type or "", len(data), capture_id, started_ms, ended_ms)
    s.uploads[upload_id] = up
    while len(s.uploads) > MAX_UPLOADS_PER_SESSION:
        _remove_upload(s, min(s.uploads.values(), key=lambda u: u.created).upload_id)
    s.touch()
    await _send_json(s.host_ws, {
        "type": "uploaded", "capture_id": capture_id, "upload_id": upload_id, "kind": kind,
        "size": len(data), "mime": up.mime, "suffix": suffix, "started_ms": started_ms, "ended_ms": ended_ms,
    })
    return {"upload_id": upload_id, "size": len(data)}


@router.get("/thermal/remote/staged/{upload_id}")
async def staged(upload_id: str, token: str = Query(...)) -> FileResponse:
    """The phone's photo/video, for the laptop's review step before Analyze."""
    s = _by_host.get(token)
    up = s.uploads.get(upload_id) if s else None
    if up is None:
        raise HTTPException(status_code=404, detail="Not found.")
    media = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
             ".webm": "video/webm", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime"}
    return FileResponse(up.path, media_type=media.get(up.suffix, "application/octet-stream"),
                        headers={"Cache-Control": "no-store"})


# --------------------------------------------------------------------------- WebSocket

@router.websocket("/thermal/remote/ws")
async def remote_ws(ws: WebSocket, role: str = "", token: str = "", code: str = "") -> None:
    ip = _client_ip(ws)
    await ws.accept()
    if role == "host":
        s = _by_host.get(token)
        if s is None:
            await _close(ws, 4404, "unknown session")
            return
        old, s.host_ws = s.host_ws, ws
        await _close(old, 4001, "opened in another tab")
        await _send_json(ws, {"type": "hello", "role": "host", "code": s.code, "phone": _phone_summary(s),
                              "server_ms": now_ms()})
        await _send_json(s.phone_ws, {"type": "host", "connected": True})
    elif role == "phone":
        fails = [t for t in _join_fails.get(ip, []) if t > time.time() - JOIN_FAIL_WINDOW_SEC]
        if len(fails) >= JOIN_FAIL_LIMIT:
            await _close(ws, 4429, "too many attempts, wait a few minutes")
            return
        s = _by_code.get(_normalize_code(code))
        if s is None:
            _join_fails[ip] = fails + [time.time()]
            await _close(ws, 4404, "code not found or expired")
            return
        old, s.phone_ws = s.phone_ws, ws
        if old is not None:
            await _send_json(old, {"type": "replaced"})
            await _close(old, 4002, "another phone joined")
        if token and s.phone_token and secrets.compare_digest(token, s.phone_token):
            pass  # same phone reconnecting: keep its token so pending uploads still work
        else:
            s.phone_token = secrets.token_urlsafe(24)
            s.phone_info = {}
        await _send_json(ws, {"type": "hello", "role": "phone", "phone_token": s.phone_token,
                              "host_connected": s.host_ws is not None, "server_ms": now_ms()})
        await _send_json(s.host_ws, {"type": "phone", **_phone_summary(s)})
    else:
        await _close(ws, 4400, "role must be host or phone")
        return

    s.touch()
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            s.touch()
            if msg.get("bytes") is not None:
                data = msg["bytes"]
                if role == "phone" and len(data) <= MAX_FRAME_BYTES:
                    if s.host_ws is not None and s.host_ws.client_state == WebSocketState.CONNECTED:
                        try:
                            await s.host_ws.send_bytes(data)
                        except Exception:
                            pass
                    await _send_json(ws, {"type": "frame_ack"})
                continue
            text = msg.get("text") or ""
            if len(text) > MAX_TEXT_BYTES:
                continue
            try:
                obj = json.loads(text)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            kind = obj.get("type")
            if kind == "ping":  # clock sync + keepalive
                await _send_json(ws, {"type": "pong", "t0": obj.get("t0"), "ts": now_ms()})
            elif role == "host" and kind in HOST_TO_PHONE:
                obj["srv_ms"] = now_ms()
                ok = await _send_json(s.phone_ws, obj)
                if not ok:
                    await _send_json(ws, {"type": "error", "capture_id": obj.get("capture_id"),
                                          "message": "The phone is not connected."})
            elif role == "phone" and kind in PHONE_TO_HOST:
                if kind == "status":
                    keep = ("model", "camera", "facing", "camera_on", "width", "height", "cameras", "visible")
                    s.phone_info = {k: obj[k] for k in keep if k in obj}
                    await _send_json(s.host_ws, {"type": "phone", **_phone_summary(s)})
                else:
                    obj["srv_ms"] = now_ms()
                    await _send_json(s.host_ws, obj)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("remote websocket error (%s)", role)
    finally:
        if role == "host" and s.host_ws is ws:
            s.host_ws = None
            await _send_json(s.phone_ws, {"type": "host", "connected": False})
        elif role == "phone" and s.phone_ws is ws:
            s.phone_ws = None
            await _send_json(s.host_ws, {"type": "phone", **_phone_summary(s)})
        s.touch()


def register(app: FastAPI, data_dir: str) -> None:
    global _staging_dir
    _staging_dir = os.path.join(data_dir, "remote_staging")
    shutil.rmtree(_staging_dir, ignore_errors=True)  # sessions do not survive a restart
    os.makedirs(_staging_dir, exist_ok=True)
    app.include_router(router)
    app.add_event_handler("startup", lambda: asyncio.get_event_loop().create_task(_expire_loop()))
