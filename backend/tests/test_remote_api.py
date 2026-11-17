"""Phone remote camera: pairing session, WebSocket relay, upload hand-off to the analysis endpoints."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import remote_api  # noqa: E402


def _client():
    app = FastAPI()
    remote_api.register(app, tempfile.mkdtemp(prefix="remote_test_"))
    return TestClient(app)


def _next(ws, kind):
    for _ in range(10):
        msg = json.loads(ws.receive_text())
        if msg["type"] == kind:
            return msg
    raise AssertionError(f"no {kind} message")


def test_session_pairing_relay_and_upload():
    client = _client()
    s = client.post("/thermal/remote/session").json()
    assert len(s["code"]) == 6 and s["qr_svg"].startswith("<svg") and s["join_url"].endswith(s["code"])
    assert client.post("/thermal/remote/session", data={"host_token": s["host_token"]}).json()["code"] == s["code"]

    with client.websocket_connect(f"/thermal/remote/ws?role=host&token={s['host_token']}") as host:
        assert _next(host, "hello")["phone"]["connected"] is False
        with client.websocket_connect(f"/thermal/remote/ws?role=phone&code={s['code'].lower()}") as phone:
            hello = _next(phone, "hello")
            assert hello["host_connected"] is True
            assert _next(host, "phone")["connected"] is True

            phone.send_text(json.dumps({"type": "ping", "t0": 1}))
            assert _next(phone, "pong")["t0"] == 1

            phone.send_text(json.dumps({"type": "status", "model": "iPhone", "camera": "Back Camera", "camera_on": True}))
            assert _next(host, "phone")["camera_on"] is True

            phone.send_bytes(b"\xff\xd8jpeg")
            assert host.receive_bytes() == b"\xff\xd8jpeg"
            assert _next(phone, "frame_ack")

            host.send_text(json.dumps({"type": "capture", "capture_id": "c1", "mode": "photo", "at_ms": 1}))
            assert _next(phone, "capture")["capture_id"] == "c1"

            started = time.time() * 1000
            up = client.post("/thermal/remote/upload",
                             data={"phone_token": hello["phone_token"], "capture_id": "c1", "kind": "photo",
                                   "started_ms": str(started)},
                             files={"file": ("phone.jpg", b"\xff\xd8photo", "image/jpeg")}).json()
            note = _next(host, "uploaded")
            assert note["upload_id"] == up["upload_id"] and note["kind"] == "photo"

            data, suffix, meta = remote_api.take_upload(s["host_token"], up["upload_id"], "photo")
            assert data == b"\xff\xd8photo" and suffix == ".jpg" and meta["device"] == "iPhone · Back Camera"
            assert client.get(f"/thermal/remote/staged/{up['upload_id']}", params={"token": s["host_token"]}).content == data
            assert client.get(f"/thermal/remote/staged/{up['upload_id']}", params={"token": "nope"}).status_code == 404
            try:
                remote_api.take_upload(s["host_token"], up["upload_id"], "video")  # wrong kind
                raise AssertionError("expected 404")
            except HTTPException as exc:
                assert exc.status_code == 404
            remote_api.release_upload(s["host_token"], up["upload_id"])
            assert client.get(f"/thermal/remote/staged/{up['upload_id']}", params={"token": s["host_token"]}).status_code == 404
        assert _next(host, "phone")["connected"] is False


def test_rejections():
    client = _client()
    s = client.post("/thermal/remote/session").json()
    try:
        with client.websocket_connect("/thermal/remote/ws?role=phone&code=ZZZZZZ") as ws:
            ws.receive_text()
        raise AssertionError("expected close")
    except WebSocketDisconnect as exc:
        assert exc.code == 4404
    r = client.post("/thermal/remote/upload", data={"phone_token": "bad", "capture_id": "c", "kind": "photo"},
                    files={"file": ("a.jpg", b"x", "image/jpeg")})
    assert r.status_code == 403
    with client.websocket_connect(f"/thermal/remote/ws?role=phone&code={s['code']}") as phone:
        token = _next(phone, "hello")["phone_token"]
        r = client.post("/thermal/remote/upload", data={"phone_token": token, "capture_id": "c", "kind": "photo"},
                        files={"file": ("a.exe", b"x", "application/octet-stream")})
        assert r.status_code == 422
