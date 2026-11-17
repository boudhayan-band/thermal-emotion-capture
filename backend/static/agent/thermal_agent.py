#!/usr/bin/env python3
"""thermal-agent: stream a Fluke iSee TC01A thermal camera to the Thermal Capture web page.

Runs on the laptop the camera is plugged into. It reads frames through the community
``tc01a`` driver (libusb, https://github.com/dazchi/tc01a-python) and serves them on
http://127.0.0.1:8765 (Chrome) and https://localhost:8766 (Safari; self-signed localhost
certificate, created on first run) so the Thermal page (https://thermal.<host>/thermal/) can show a live
preview and capture a full temperature map (degrees C) together with the RGB photo.

Endpoints (local only):
  GET  /status        connection state, device info, fps, rotation
  GET  /preview.jpg   latest frame, colour palette, rotated (for the live preview)
  GET  /capture.npy   latest frame as a float32 temperature map in degrees C (rotated)
  GET  /record.npz?seconds=5&fps=10
                      record a clip; .npz with frames (int16, 0.01 C), t (s), scale
  POST /rotate        rotate the view by 90 degrees clockwise
  POST /shutter       trigger the camera shutter / NUC (flat-field correction)

Security: listens on 127.0.0.1 only and answers only requests from the allowed web origins.

Usage:
  python thermal_agent.py                    # real camera (macOS: may need sudo)
  python thermal_agent.py --https-port 0     # HTTP only (no Safari port)
  python thermal_agent.py --demo             # synthetic face, no camera needed
  python thermal_agent.py --rotate 90        # if the image appears sideways
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import os
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional

import cv2
import numpy as np

VERSION = "0.3.0"
MAX_RECORD_SECONDS = 15
DEFAULT_RECORD_FPS = 10
DEFAULT_ORIGINS = ["https://thermal.18.61.179.93.sslip.io"]
DEFAULT_PORT = 8765
DEFAULT_HTTPS_PORT = 8766
CERT_DIR = Path(__file__).resolve().parent / "certs"
CERT_FILE = CERT_DIR / "localhost.pem"
KEY_FILE = CERT_DIR / "localhost-key.pem"

log = logging.getLogger("thermal-agent")


# --------------------------------------------------------------------------- sources

class DemoSource:
    """Synthetic 256x192 thermal face (about 34 C skin, warm eye corners, cool nose)."""

    def __init__(self) -> None:
        self.t0 = time.time()

    def info(self) -> Dict[str, str]:
        return {"model": "demo (synthetic face)", "firmware": "-"}

    def read(self) -> np.ndarray:
        time.sleep(1 / 15)
        t = time.time() - self.t0
        h, w = 192, 256
        temp = np.full((h, w), 23.0, np.float32)
        cx = int(128 + 6 * np.sin(t * 0.7))
        cv2.ellipse(temp, (cx, 92), (50, 66), 0, 0, 360, 34.2, -1)
        cv2.rectangle(temp, (cx - 26, 150), (cx + 26, 191), 33.4, -1)
        for dx in (-20, 20):
            cv2.ellipse(temp, (cx + dx, 80), (10, 6), 0, 0, 360, 35.4, -1)
            cv2.circle(temp, (cx + dx // 2, 82), 2, 36.4, -1)
        cv2.ellipse(temp, (cx, 106), (7, 11), 0, 0, 360, 31.5, -1)
        cv2.ellipse(temp, (cx, 128), (14, 5), 0, 0, 360, 33.0, -1)
        temp = cv2.GaussianBlur(temp, (7, 7), 2.0)
        return temp + np.random.normal(0, 0.06, temp.shape).astype(np.float32)

    def shutter(self) -> None:
        pass

    def close(self) -> None:
        pass


class CameraSource:
    """Real TC01A through the tc01a driver."""

    def __init__(self, emissivity: Optional[float]) -> None:
        from tc01a import TC01A  # imported here so --demo works without the driver installed

        self.cam = TC01A().open()
        if emissivity is not None:
            try:
                self.cam.set_emissivity(emissivity)
            except Exception as exc:  # not fatal
                log.warning("could not set emissivity: %s", exc)
        self.cam.start()

    def info(self) -> Dict[str, str]:
        try:
            return {str(k): str(v) for k, v in self.cam.info().items()}
        except Exception:
            return {"model": "TC01A"}

    def read(self) -> np.ndarray:
        return np.array(self.cam.read(timeout=3.0).celsius, dtype=np.float32, copy=True)

    def shutter(self) -> None:
        self.cam.shutter()

    def close(self) -> None:
        try:
            self.cam.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- frame pump

class FramePump:
    """Reads frames in a background thread, keeps the latest, reconnects on errors."""

    def __init__(self, demo: bool, emissivity: Optional[float], rotate: int) -> None:
        self.demo = demo
        self.emissivity = emissivity
        self.rotate = rotate % 360
        self.lock = threading.Lock()
        self.latest: Optional[np.ndarray] = None
        self.latest_at = 0.0
        self.frames = 0
        self.fps = 0.0
        self.error: Optional[str] = None
        self.device: Dict[str, str] = {}
        self.source = None
        self._stop = threading.Event()
        threading.Thread(target=self._run, name="frame-pump", daemon=True).start()

    def _connect(self) -> None:
        self.source = DemoSource() if self.demo else CameraSource(self.emissivity)
        self.device = self.source.info()
        self.error = None
        log.info("connected: %s", self.device)

    def _run(self) -> None:
        window_start, window_frames = time.time(), 0
        while not self._stop.is_set():
            if self.source is None:
                try:
                    self._connect()
                except Exception as exc:
                    self.error = f"{type(exc).__name__}: {exc}"
                    log.warning("camera not available: %s (retrying in 2 s)", self.error)
                    time.sleep(2)
                    continue
            try:
                temp = self.source.read()
            except Exception as exc:
                self.error = f"{type(exc).__name__}: {exc}"
                log.warning("read failed: %s (reconnecting)", self.error)
                self.source.close()
                self.source = None
                time.sleep(1)
                continue
            with self.lock:
                self.latest = temp
                self.latest_at = time.time()
                self.frames += 1
            window_frames += 1
            if time.time() - window_start >= 1.0:
                self.fps = window_frames / (time.time() - window_start)
                window_start, window_frames = time.time(), 0

    def frame(self) -> Optional[np.ndarray]:
        """Latest frame in degrees C, rotated clockwise by self.rotate."""
        with self.lock:
            if self.latest is None or time.time() - self.latest_at > 5:
                return None
            temp = self.latest.copy()
        return np.ascontiguousarray(np.rot90(temp, k=-(self.rotate // 90)))

    def shutter(self) -> None:
        if self.source is not None:
            self.source.shutter()

    def record(self, seconds: float, fps: float) -> Dict[str, Any]:
        """Collect rotated frames for ``seconds`` at up to ``fps`` (only new camera frames are used)."""
        interval = 1.0 / fps
        frames, stamps = [], []
        start = time.time()
        last_count = -1
        next_at = start
        while True:
            now = time.time()
            if now - start > seconds + 1e-3:
                break
            if now < next_at or self.frames == last_count:
                time.sleep(0.004)
                continue
            last_count = self.frames
            temp = self.frame()
            if temp is None:
                raise RuntimeError(self.error or "camera stopped sending frames")
            frames.append(temp)
            stamps.append(now - start)
            next_at += interval
            if next_at < now:  # fell behind (slow camera): don't burst to catch up
                next_at = now + interval
        if not frames:
            raise RuntimeError("no frames recorded")
        return {"frames": np.stack(frames), "t": np.array(stamps, dtype=np.float32), "start": start}


def render_preview(temp: np.ndarray) -> bytes:
    lo, hi = np.percentile(temp, 1), np.percentile(temp, 99.5)
    gray = (np.clip((temp - lo) / max(hi - lo, 0.1), 0, 1) * 255).astype(np.uint8)
    color = cv2.applyColorMap(gray, cv2.COLORMAP_INFERNO)
    color = cv2.resize(color, (temp.shape[1] * 2, temp.shape[0] * 2), interpolation=cv2.INTER_CUBIC)
    ok, jpg = cv2.imencode(".jpg", color, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return jpg.tobytes() if ok else b""


# --------------------------------------------------------------------------- HTTP

def make_handler(pump: FramePump, origins: set, features: Optional[list] = None):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"thermal-agent/{VERSION}"

        def log_message(self, fmt: str, *args: Any) -> None:  # quieter than the default
            log.debug("%s - %s", self.address_string(), fmt % args)

        # -- CORS / origin checks
        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin")
            return origin is None or origin in origins

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Expose-Headers",
                                 "X-Frame-Width, X-Frame-Height, X-Temp-Min, X-Temp-Max, X-Rotation, X-Device, "
                                 "X-Record-Start, X-Frames")

        def _send(self, code: int, body: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj: Dict[str, Any]) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        def do_OPTIONS(self) -> None:  # CORS + Private Network Access preflight
            if not self._origin_ok():
                self._send(403, b"origin not allowed", "text/plain")
                return
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self) -> None:
            if not self._origin_ok():
                self._send(403, b"origin not allowed", "text/plain")
                return
            path = self.path.split("?", 1)[0]
            if path == "/status":
                self._json(200, {
                    "agent": "thermal-agent", "version": VERSION, "demo": pump.demo,
                    "connected": pump.frame() is not None, "error": pump.error,
                    "device": pump.device, "fps": round(pump.fps, 1), "frames": pump.frames,
                    "rotation": pump.rotate, "features": features if features is not None else ["record"],
                })
            elif path == "/record.npz":
                self._record()
            elif path in ("/preview.jpg", "/capture.npy"):
                temp = pump.frame()
                if temp is None:
                    self._json(503, {"error": pump.error or "no frame from the camera yet"})
                    return
                extra = {
                    "X-Frame-Width": str(temp.shape[1]), "X-Frame-Height": str(temp.shape[0]),
                    "X-Temp-Min": f"{float(temp.min()):.2f}", "X-Temp-Max": f"{float(temp.max()):.2f}",
                    "X-Rotation": str(pump.rotate),
                    "X-Device": ("demo" if pump.demo else pump.device.get("model", "TC01A"))[:60],
                }
                if path == "/preview.jpg":
                    self._send(200, render_preview(temp), "image/jpeg", extra)
                else:
                    buf = io.BytesIO()
                    np.save(buf, temp.astype(np.float32))
                    self._send(200, buf.getvalue(), "application/octet-stream", extra)
            else:
                self._json(404, {"error": "not found"})

        def _record(self) -> None:
            from urllib.parse import parse_qs, urlsplit

            query = parse_qs(urlsplit(self.path).query)
            try:
                seconds = float(query.get("seconds", ["5"])[0])
                fps = float(query.get("fps", [str(DEFAULT_RECORD_FPS)])[0])
            except ValueError:
                self._json(400, {"error": "seconds and fps must be numbers"})
                return
            if not (0.5 <= seconds <= MAX_RECORD_SECONDS) or not (1 <= fps <= 30):
                self._json(400, {"error": f"seconds must be 0.5-{MAX_RECORD_SECONDS}, fps 1-30"})
                return
            if pump.frame() is None:
                self._json(503, {"error": pump.error or "no frame from the camera yet"})
                return
            log.info("recording %.1f s at %.0f fps", seconds, fps)
            try:
                clip = pump.record(seconds, fps)
            except Exception as exc:
                self._json(503, {"error": str(exc)})
                return
            frames = clip["frames"]
            # 0.01 C steps in int16 halve the size of float32 and keep plenty of precision.
            centi = np.clip(np.round(frames * 100.0), -32768, 32767).astype(np.int16)
            buf = io.BytesIO()
            np.savez_compressed(buf, frames=centi, t=clip["t"], scale=np.float32(0.01),
                                rotation=np.int16(pump.rotate))
            log.info("recorded %d frames", len(frames))
            self._send(200, buf.getvalue(), "application/octet-stream", {
                "X-Frame-Width": str(frames.shape[2]), "X-Frame-Height": str(frames.shape[1]),
                "X-Temp-Min": f"{float(frames.min()):.2f}", "X-Temp-Max": f"{float(frames.max()):.2f}",
                "X-Rotation": str(pump.rotate), "X-Frames": str(len(frames)),
                "X-Record-Start": f"{clip['start'] * 1000:.0f}",
                "X-Device": ("demo" if pump.demo else pump.device.get("model", "TC01A"))[:60],
            })

        def do_POST(self) -> None:
            if not self._origin_ok():
                self._send(403, b"origin not allowed", "text/plain")
                return
            path = self.path.split("?", 1)[0]
            if path == "/rotate":
                pump.rotate = (pump.rotate + 90) % 360
                self._json(200, {"rotation": pump.rotate})
            elif path == "/shutter":
                try:
                    pump.shutter()
                    self._json(200, {"ok": True})
                except Exception as exc:
                    self._json(500, {"error": str(exc)})
            else:
                self._json(404, {"error": "not found"})

    return Handler


# --------------------------------------------------------------------------- HTTPS (Safari)

def ensure_certificate() -> bool:
    """Create a self-signed certificate for localhost / 127.0.0.1 (not a CA) if missing."""
    if CERT_FILE.exists() and KEY_FILE.exists():
        return False
    import datetime
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "thermal-agent localhost"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "thermal-agent (this Mac only)")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=820))  # Apple: TLS certs <= 825 days
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            x509.IPAddress(ipaddress.ip_address("::1")),
        ]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False, content_commitment=False,
                                     data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                     crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                   serialization.NoEncryption()))
    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    sudo_user = os.environ.get("SUDO_USER")
    if sudo_user and hasattr(os, "chown"):  # created under sudo: hand the files back to the user
        import pwd
        pw = pwd.getpwnam(sudo_user)
        for p in (CERT_DIR, CERT_FILE, KEY_FILE):
            os.chown(p, pw.pw_uid, pw.pw_gid)
    return True


def make_https_server(port: int, handler) -> Optional[ThreadingHTTPServer]:
    try:
        created = ensure_certificate()
    except ImportError:
        log.warning("Safari port disabled: run  .venv/bin/pip install -r requirements.txt  (needs 'cryptography')")
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(CERT_FILE, KEY_FILE)
    class QuietTLSServer(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address) -> None:  # untrusted cert, aborted handshake
            import sys
            log.debug("TLS connection from %s failed: %s", client_address, sys.exc_info()[1])

    server = QuietTLSServer(("127.0.0.1", port), handler)
    # Handshake in the request thread, so a stalled client cannot block accept().
    server.socket = ctx.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    if created:
        log.info("Created a certificate for localhost: %s", CERT_FILE)
    log.info("Safari: trust it once (Mac password needed), then use https://localhost:%d on the page:", port)
    log.info('  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "%s"',
             CERT_FILE)
    return server


def main() -> None:
    ap = argparse.ArgumentParser(description="Stream a Fluke iSee TC01A to the Thermal Capture page.")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--https-port", type=int, default=DEFAULT_HTTPS_PORT,
                    help="HTTPS port for Safari (self-signed localhost certificate); 0 to disable")
    ap.add_argument("--demo", action="store_true", help="synthetic face instead of the camera")
    ap.add_argument("--rotate", type=int, choices=(0, 90, 180, 270), default=0,
                    help="rotate frames clockwise (also adjustable from the page)")
    ap.add_argument("--emissivity", type=float, default=0.98,
                    help="emissivity sent to the camera (human skin ~0.98); use 0 to leave unchanged")
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="extra web origin allowed to use the agent (repeatable)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    origins = set(DEFAULT_ORIGINS + args.allow_origin)
    pump = FramePump(args.demo, args.emissivity or None, args.rotate)
    features = ["record"]
    handler = make_handler(pump, origins, features)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    server.daemon_threads = True
    log.info("thermal-agent %s on http://127.0.0.1:%d (%s) — allowed origins: %s",
             VERSION, args.port, "DEMO" if args.demo else "camera", ", ".join(sorted(origins)))
    https_server = make_https_server(args.https_port, handler) if args.https_port else None
    if https_server is not None:
        features.append("https")
        threading.Thread(target=https_server.serve_forever, name="https", daemon=True).start()
        log.info("thermal-agent %s on https://localhost:%d (Safari)", VERSION, args.https_port)
    log.info("Open the Thermal page (Live) or the Synced page, and press Connect. Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if https_server is not None:
            https_server.shutdown()
            https_server.server_close()
        if pump.source is not None:
            pump.source.close()


if __name__ == "__main__":
    main()
