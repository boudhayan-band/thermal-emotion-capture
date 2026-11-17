import os

# Must run before anything imports TensorFlow (emotiefflib does, when TF is installed): the M3MSTL
# thermal model is a Keras 2 .h5 file, which TF >= 2.16 only loads via the tf-keras package.
os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import base64
import json
import logging
import mimetypes
import re
import secrets
import sqlite3
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import boto3
import cv2
import numpy as np
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from openpyxl import Workbook
from infer_emotion_va import predict_faces

app = FastAPI(title="Facial Emotion Recognition API", version="1.0.0")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
# Admin dashboard files live outside STATIC_DIR so they are only reachable through the authenticated routes.
ADMIN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin")
ADMIN_FILES = {"admin.js": "application/javascript", "admin.css": "text/css"}

# HTTP Basic credentials for /admin/. The dashboard is disabled until ADMIN_PASSWORD is set.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")

logger = logging.getLogger("emotion_api")

# S3 storage for captured media. Uploads are skipped (with a warning) if S3_BUCKET_NAME is unset.
S3_BUCKET_NAME = os.environ.get("S3_BUCKET_NAME")
S3_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
S3_PREFIX = os.environ.get("S3_CAPTURE_PREFIX", "captures").strip("/")

# SQLite tracks capture metadata (emotion/confidence/S3 location) so it can be exported to Excel.
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "records.db")
MEDIA_DIR = os.path.join(DATA_DIR, "media")

_s3_client = None
_recognizer = None
_face_detector = None
# Models are loaded lazily from both the request thread (/predict) and the background collect worker.
_model_init_lock = threading.Lock()

# Blind captures (/collect/submit) are analyzed one at a time off the request path, so the participant
# never waits for (or sees) the result. One worker keeps CPU inference from piling up.
_collect_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="collect-analysis")

# Videos are analyzed over their first VIDEO_SECONDS of footage, one frame every VIDEO_SAMPLE_INTERVAL_SEC.
VIDEO_SECONDS = 5.0
VIDEO_SAMPLE_INTERVAL_SEC = 0.2


def _get_recognizer():
    global _recognizer
    with _model_init_lock:
        if _recognizer is None:
            from emotiefflib.facial_analysis import EmotiEffLibRecognizer

            _recognizer = EmotiEffLibRecognizer(
                engine="torch",
                model_name="enet_b0_8_va_mtl",
                device="cpu",
            )
    return _recognizer


def _get_s3_client():
    global _s3_client
    if not S3_BUCKET_NAME:
        return None
    if _s3_client is None:
        _s3_client = boto3.client("s3", region_name=S3_REGION)
    return _s3_client


def _init_db() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS subjects (
                subject_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER,
                diet TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS captures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                media_type TEXT NOT NULL,
                original_filename TEXT,
                s3_key TEXT,
                s3_url TEXT,
                emotion TEXT,
                confidence REAL,
                message TEXT,
                valence REAL,
                arousal REAL,
                subject_id TEXT,
                capture_id TEXT,
                name TEXT,
                age INTEGER,
                diet TEXT,
                media_path TEXT,
                frame_results_json TEXT
            )
            """
        )
        conn.commit()
        columns = {row[1] for row in conn.execute("PRAGMA table_info(captures)")}
        if "valence" not in columns:
            conn.execute("ALTER TABLE captures ADD COLUMN valence REAL")
        if "arousal" not in columns:
            conn.execute("ALTER TABLE captures ADD COLUMN arousal REAL")
        migrations = {
            "subject_id": "TEXT",
            "capture_id": "TEXT",
            "name": "TEXT",
            "age": "INTEGER",
            "diet": "TEXT",
            "media_path": "TEXT",
            "frame_results_json": "TEXT",
            # 'blind' for /collect/submit; NULL means the interactive /predict app.
            "capture_mode": "TEXT",
            # Only the /collect/ page asks for a roll number; NULL for the interactive app.
            "roll_no": "TEXT",
            "gender": "TEXT",
            # 'pending' / 'done' / 'failed' for blind captures; NULL means analyzed inline by /predict.
            "analysis_status": "TEXT",
        }
        for column, column_type in migrations.items():
            if column not in columns:
                conn.execute(f"ALTER TABLE captures ADD COLUMN {column} {column_type}")
        subject_columns = {row[1] for row in conn.execute("PRAGMA table_info(subjects)")}
        if "roll_no" not in subject_columns:
            conn.execute("ALTER TABLE subjects ADD COLUMN roll_no TEXT")
        if "gender" not in subject_columns:
            conn.execute("ALTER TABLE subjects ADD COLUMN gender TEXT")
        conn.commit()
    finally:
        conn.close()


_init_db()


def _upload_capture_to_s3(contents: bytes, filename: str, content_type: str) -> Dict[str, Optional[str]]:
    """Uploads the raw captured media to S3; returns {key, url}, both None if not configured or on failure."""
    client = _get_s3_client()
    if client is None:
        return {"key": None, "url": None}

    suffix = os.path.splitext(filename)[1] or ""
    date_path = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    key = f"{S3_PREFIX}/{date_path}/{uuid.uuid4().hex}{suffix}"
    try:
        client.put_object(Bucket=S3_BUCKET_NAME, Key=key, Body=contents, ContentType=content_type)
        region_part = f".{S3_REGION}" if S3_REGION else ""
        url = f"https://{S3_BUCKET_NAME}.s3{region_part}.amazonaws.com/{key}"
        return {"key": key, "url": url}
    except (BotoCoreError, ClientError) as exc:
        logger.warning("Failed to upload capture to S3: %s", exc)
        return {"key": None, "url": None}


def _save_capture_record(
    media_type: str,
    original_filename: str,
    s3_key: Optional[str],
    s3_url: Optional[str],
    result: Dict[str, Any],
    subject_id: str,
    capture_id: str,
    name: str,
    age: Optional[int],
    diet: str,
    media_path: str,
    gender: str,
) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO captures
                (created_at, media_type, original_filename, s3_key, s3_url, emotion, confidence, message,
                 valence, arousal, subject_id, capture_id, name, age, diet, media_path, frame_results_json,
                 gender)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                datetime.now(timezone.utc).isoformat(),
                media_type,
                original_filename,
                s3_key,
                s3_url,
                result.get("emotion"),
                result.get("confidence"),
                result.get("message"),
                result.get("valence"),
                result.get("arousal"),
                subject_id,
                capture_id,
                name,
                age,
                diet,
                media_path,
                json.dumps(_stored_frame_results(result)),
                gender,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _stored_frame_results(result: Dict[str, Any]) -> Any:
    """Keep numeric per-face/per-frame results without embedding image data in SQLite."""
    if isinstance(result.get("frames"), list):
        return [
            {key: value for key, value in frame.items() if key != "image"}
            for frame in result["frames"]
        ]
    return result.get("faces", [])


def _safe_component(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return cleaned[:80] or fallback


def _subject_id(value: Optional[str]) -> str:
    if value and re.fullmatch(r"sub_[0-9a-f]{32}", value):
        return value
    return f"sub_{uuid.uuid4().hex}"


def _store_media(contents: bytes, filename: str, subject_id: str, capture_id: str) -> str:
    suffix = os.path.splitext(filename)[1].lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".mp4", ".mov", ".avi", ".m4v", ".webm", ".3gp"}:
        suffix = ".bin"
    subject_dir = os.path.join(MEDIA_DIR, _safe_component(subject_id, "subject"))
    os.makedirs(subject_dir, exist_ok=True)
    stored_name = f"{_safe_component(capture_id, 'capture')}{suffix}"
    absolute_path = os.path.join(subject_dir, stored_name)
    with open(absolute_path, "wb") as media_file:
        media_file.write(contents)
    return os.path.relpath(absolute_path, os.path.dirname(os.path.abspath(__file__)))


def _register_subject(
    subject_id: str, name: str, age: Optional[int], diet: str, gender: str, roll_no: Optional[str] = None
) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO subjects (subject_id, name, age, diet, gender, roll_no, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(subject_id) DO UPDATE SET name=excluded.name, age=excluded.age, diet=excluded.diet,
                gender=excluded.gender,
                roll_no=COALESCE(excluded.roll_no, subjects.roll_no)
            """,
            (subject_id, name, age, diet, gender, roll_no, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


def _normalize_emotion_name(name: Any) -> str:
    if name is None:
        return "Unknown"
    return str(name).strip().title()


def _predict_from_face_batch(face_images: List[np.ndarray], recognizer: Any) -> Dict[str, Any]:
    if not face_images:
        return {"emotion": "Unknown", "confidence": 0.0, "message": "No face was detected in the input."}

    predictions = predict_faces(face_images, recognizer)
    if not predictions:
        return {"emotion": "Unknown", "confidence": 0.0, "message": "No valid scores were produced for the input."}

    mean_emotion_scores = np.mean([item["emotion_scores"] for item in predictions], axis=0)
    emotion = recognizer.idx_to_emotion_class[int(np.argmax(mean_emotion_scores))]
    confidence = float(np.max(mean_emotion_scores))

    return {
        "emotion": _normalize_emotion_name(emotion),
        "confidence": round(confidence, 4),
        "valence": round(float(np.mean([item["valence"] for item in predictions])), 4),
        "arousal": round(float(np.mean([item["arousal"] for item in predictions])), 4),
        "faces": [
            {
                "emotion": _normalize_emotion_name(item["emotion"]),
                "confidence": round(float(item["confidence"]), 4),
                "valence": round(float(item["valence"]), 4),
                "arousal": round(float(item["arousal"]), 4),
            }
            for item in predictions
        ],
        "message": "Emotion, valence, and arousal detected from the input media.",
    }


def _get_face_detector():
    global _face_detector
    with _model_init_lock:
        if _face_detector is None:
            from facenet_pytorch import MTCNN

            _face_detector = MTCNN(keep_all=True, post_process=False, min_face_size=40, device="cpu")
    return _face_detector


def _detect_faces(frame: np.ndarray) -> List[np.ndarray]:
    boxes, probs = _get_face_detector().detect(frame, landmarks=False)
    if boxes is None or len(boxes) == 0 or probs is None or len(probs) == 0:
        return []

    face_images: List[np.ndarray] = []
    for box, probability in zip(boxes, probs):
        if probability is None or probability < 0.90:
            continue
        x1, y1, x2, y2 = np.rint(np.asarray(box, dtype=np.float32)).astype(int)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
        face = frame[y1:y2, x1:x2, :]
        if face.size > 0:
            face_images.append(face)
    return face_images


def _encode_face_jpeg_data_url(face_rgb: np.ndarray) -> str:
    face_bgr = cv2.cvtColor(face_rgb, cv2.COLOR_RGB2BGR)
    ok, buffer = cv2.imencode(".jpg", face_bgr)
    if not ok:
        return ""
    encoded = base64.b64encode(buffer.tobytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _analyze_image(image_path: str) -> Dict[str, Any]:
    try:
        image = cv2.imread(image_path)
        if image is None:
            return {
                "emotion": "Unknown",
                "confidence": 0.0,
                "message": "The uploaded image could not be read.",
            }

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        face_images = _detect_faces(rgb)
        if not face_images:
            return {
                "emotion": "Unknown",
                "confidence": 0.0,
                "message": "No face was detected in the image.",
            }

        result = _predict_from_face_batch(face_images, _get_recognizer())
        return result
    except Exception as exc:  # pragma: no cover - keep the service usable even if dependencies are absent
        return {
            "emotion": "Unknown",
            "confidence": 0.0,
            "message": f"Inference failed: {exc}",
            "fallback": True,
        }


def _frame_time_sec(cap: Any, frame_index: int, fps: float) -> float:
    """Position of the frame just read, in seconds of video time (not processing time)."""
    position_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
    if position_ms > 0 or frame_index == 0:
        return position_ms / 1000.0
    # Some containers report no timestamps; browser WebM files can also report a bogus FPS (e.g. 1000).
    return frame_index / (fps if 1 <= fps <= 120 else 30.0)


def _analyze_video(video_path: str, max_seconds: float = VIDEO_SECONDS) -> Dict[str, Any]:
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {
                "emotion": "Unknown",
                "confidence": 0.0,
                "message": "The uploaded video could not be opened.",
            }

        recognizer = _get_recognizer()
        sampled_faces: List[np.ndarray] = []
        sampled_timestamps: List[float] = []
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frame_index = 0
        sampled_count = 0
        next_sample_sec = 0.0
        clip_end_sec = 0.0

        # Walk the whole clip by its own timestamps so slow face detection never shortens the analysis.
        while cap.isOpened():
            ok, frame = cap.read()
            if not ok:
                break
            frame_sec = _frame_time_sec(cap, frame_index, fps)
            frame_index += 1
            if frame_sec > max_seconds:
                break
            clip_end_sec = frame_sec
            if frame_sec + 1e-6 < next_sample_sec:
                continue
            while next_sample_sec <= frame_sec + 1e-6:
                next_sample_sec += VIDEO_SAMPLE_INTERVAL_SEC

            sampled_count += 1
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            face_images = _detect_faces(rgb)
            if face_images:
                sampled_faces.append(face_images[0])
                sampled_timestamps.append(round(frame_sec, 2))

        cap.release()

        if not sampled_faces:
            return {
                "emotion": "Unknown",
                "confidence": 0.0,
                "message": f"No face was detected in the {max_seconds:g} second video clip.",
            }

        predictions = predict_faces(sampled_faces, recognizer)

        frames: List[Dict[str, Any]] = []
        for i, (face, prediction) in enumerate(zip(sampled_faces, predictions)):
            frames.append(
                {
                    "timestamp": sampled_timestamps[i],
                    "image": _encode_face_jpeg_data_url(face),
                    "emotion": _normalize_emotion_name(prediction["emotion"]),
                    "confidence": round(float(prediction["confidence"]), 4),
                    "valence": round(float(prediction["valence"]), 4),
                    "arousal": round(float(prediction["arousal"]), 4),
                }
            )

        mean_emotion_scores = np.mean([item["emotion_scores"] for item in predictions], axis=0)
        final_emotion = _normalize_emotion_name(
            recognizer.idx_to_emotion_class[int(np.argmax(mean_emotion_scores))]
        )
        final_confidence = round(float(np.max(mean_emotion_scores)), 4)

        return {
            "emotion": final_emotion,
            "confidence": final_confidence,
            "valence": round(float(np.mean([item["valence"] for item in predictions])), 4),
            "arousal": round(float(np.mean([item["arousal"] for item in predictions])), 4),
            "message": f"Emotion detected from the {max_seconds:g} second video clip.",
            "frames": frames,
            "logic": (
                f"Sampled one frame every {VIDEO_SAMPLE_INTERVAL_SEC:g} s across the {clip_end_sec:.1f} s clip "
                f"({sampled_count} frames, {len(frames)} with a detected face). A face was cropped from each sampled frame using an MTCNN face "
                "detector, then the EmotiEffLib emotion model produced a softmax probability distribution "
                "over emotions for each cropped face individually (shown per-frame above). The per-frame "
                "probability distributions were then averaged together, and the emotion with the highest "
                f"average probability, \"{final_emotion}\", was reported as the final result."
            ),
        }
    except Exception as exc:  # pragma: no cover - keep the service usable even if dependencies are absent
        return {
            "emotion": "Unknown",
            "confidence": 0.0,
            "message": f"Inference failed: {exc}",
            "fallback": True,
        }


def _is_video_file(filename: str) -> bool:
    lower_name = (filename or '').lower()
    return lower_name.endswith(('.mp4', '.mov', '.avi', '.m4v', '.webm', '.3gp'))


_basic_auth = HTTPBasic(realm="Emotion Capture admin", auto_error=False)


def _require_admin(credentials: Optional[HTTPBasicCredentials] = Depends(_basic_auth)) -> None:
    if not ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="Admin dashboard is disabled: set ADMIN_PASSWORD.")
    valid = credentials is not None and (
        secrets.compare_digest(credentials.username.encode(), ADMIN_USERNAME.encode())
        & secrets.compare_digest(credentials.password.encode(), ADMIN_PASSWORD.encode())
    )
    if not valid:
        raise HTTPException(
            status_code=401,
            detail="Admin credentials required.",
            headers={"WWW-Authenticate": 'Basic realm="Emotion Capture admin"'},
        )


def _media_url(media_path: Optional[str]) -> Optional[str]:
    """Map a stored path like data/media/<subject>/<file> to its /media/<subject>/<file> URL."""
    if not media_path:
        return None
    parts = Path(media_path).parts
    if len(parts) < 2:
        return None
    return f"/admin/media/{parts[-2]}/{parts[-1]}"


@app.get("/health")
def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/media/{subject_id}/{filename}", include_in_schema=False)
def legacy_media_redirect(subject_id: str, filename: str) -> RedirectResponse:
    """Old public media links now go through the admin login."""
    return RedirectResponse(url=f"/admin/media/{quote(subject_id)}/{quote(filename)}")


@app.get("/admin/media/{subject_id}/{filename}", dependencies=[Depends(_require_admin)])
def get_media(subject_id: str, filename: str) -> FileResponse:
    """Serve a stored capture only from the subject's media directory."""
    subject_dir = Path(MEDIA_DIR, _safe_component(subject_id, "subject")).resolve()
    media_path = (subject_dir / _safe_component(filename, "capture")).resolve()
    if subject_dir not in media_path.parents or not media_path.is_file():
        raise HTTPException(status_code=404, detail="Media not found.")
    return FileResponse(media_path)


def _validate_submission(file: UploadFile, name: str, age: Optional[int], diet: str) -> Tuple[str, str]:
    """Shared checks for /predict and /collect/submit; returns the normalized (name, diet)."""
    if file.filename is None or file.filename.strip() == "":
        raise HTTPException(status_code=400, detail="No file was provided.")
    name = name.strip()
    diet = diet.strip().title()
    if not name or name.lower() == "unknown":
        raise HTTPException(status_code=422, detail="Subject name is required.")
    if age is None or age < 1 or age > 120:
        raise HTTPException(status_code=422, detail="Subject age must be between 1 and 120.")
    if diet not in {"Veg", "Non-Veg"}:
        raise HTTPException(status_code=422, detail="Diet must be Veg or Non-Veg.")
    return name, diet


GENDERS = {"Male", "Female", "Other"}


def _validate_gender(gender: str) -> str:
    gender = gender.strip().title()
    if gender not in GENDERS:
        raise HTTPException(status_code=422, detail="Gender must be Male, Female or Other.")
    return gender


@app.post("/predict")
async def predict_emotion(
    file: UploadFile = File(...),
    subject_id: Optional[str] = Form(None),
    name: str = Form("Unknown"),
    age: Optional[int] = Form(None),
    gender: str = Form(""),
    diet: str = Form("Unknown"),
) -> Dict[str, Any]:
    name, diet = _validate_submission(file, name, age, diet)
    gender = _validate_gender(gender)

    subject_id = _subject_id(subject_id)
    capture_id = f"cap_{uuid.uuid4().hex}"
    _register_subject(subject_id, name, age, diet, gender)

    is_video = _is_video_file(file.filename)
    suffix = os.path.splitext(file.filename)[1] or (".mp4" if is_video else ".jpg")
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        contents = await file.read()
        temp_file.write(contents)
        temp_path = temp_file.name

    try:
        result = _analyze_video(temp_path) if is_video else _analyze_image(temp_path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    default_content_type = "video/webm" if is_video else "image/jpeg"
    upload = _upload_capture_to_s3(contents, file.filename, file.content_type or default_content_type)
    media_path = _store_media(contents, file.filename, subject_id, capture_id)
    result.update(
        {
            "subject_id": subject_id,
            "capture_id": capture_id,
            "name": name,
            "age": age,
            "gender": gender,
            "diet": diet,
            "media_path": media_path,
            "media_url": _media_url(media_path),
        }
    )
    _save_capture_record(
        media_type="video" if is_video else "image",
        original_filename=file.filename,
        s3_key=upload["key"],
        s3_url=upload["url"],
        result=result,
        subject_id=subject_id,
        capture_id=capture_id,
        name=name,
        age=age,
        diet=diet,
        media_path=media_path,
        gender=gender,
    )
    result["stored_to_s3"] = upload["url"] is not None
    return result


# ---------- Blind collection (/collect/) ----------
# The participant only gets an acknowledgement; analysis and the DB update happen in the background.


def _insert_pending_capture(
    media_type: str,
    original_filename: str,
    subject_id: str,
    capture_id: str,
    name: str,
    age: Optional[int],
    diet: str,
    media_path: str,
    roll_no: str,
    gender: str,
) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO captures
                (created_at, media_type, original_filename, subject_id, capture_id, name, age, diet,
                 media_path, roll_no, gender, capture_mode, analysis_status, message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blind', 'pending', 'Queued for analysis.')
            """,
            (
                datetime.now(timezone.utc).isoformat(),
                media_type,
                original_filename,
                subject_id,
                capture_id,
                name,
                age,
                diet,
                media_path,
                roll_no,
                gender,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _update_capture_analysis(capture_id: str, status: str, result: Dict[str, Any], upload: Dict[str, Optional[str]]) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            UPDATE captures
            SET emotion = ?, confidence = ?, message = ?, valence = ?, arousal = ?,
                frame_results_json = ?, s3_key = ?, s3_url = ?, analysis_status = ?
            WHERE capture_id = ?
            """,
            (
                result.get("emotion"),
                result.get("confidence"),
                result.get("message"),
                result.get("valence"),
                result.get("arousal"),
                json.dumps(_stored_frame_results(result)),
                upload["key"],
                upload["url"],
                status,
                capture_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _analyze_blind_capture(capture_id: str, media_path: str, original_filename: str, content_type: str) -> None:
    """Background job: analyze the stored media and fill in the pending capture row."""
    absolute_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), media_path)
    is_video = _is_video_file(original_filename)
    upload: Dict[str, Optional[str]] = {"key": None, "url": None}
    try:
        result = _analyze_video(absolute_path) if is_video else _analyze_image(absolute_path)
        with open(absolute_path, "rb") as media_file:
            upload = _upload_capture_to_s3(media_file.read(), original_filename, content_type)
        status = "failed" if result.get("fallback") else "done"
    except Exception as exc:  # keep the worker alive; the row records the failure
        logger.exception("Blind capture %s could not be analyzed", capture_id)
        result = {"emotion": "Unknown", "confidence": 0.0, "message": f"Inference failed: {exc}"}
        status = "failed"
    _update_capture_analysis(capture_id, status, result, upload)


def _queue_blind_analysis(capture_id: str, media_path: str, original_filename: str, media_type: str) -> None:
    default_content_type = "video/webm" if media_type == "video" else "image/jpeg"
    content_type = mimetypes.guess_type(original_filename)[0] or default_content_type
    _collect_executor.submit(_analyze_blind_capture, capture_id, media_path, original_filename, content_type)


@app.on_event("startup")
def _resume_pending_blind_captures() -> None:
    """Re-queue blind captures that were still pending when the server last stopped."""
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            """
            SELECT capture_id, media_path, original_filename, media_type FROM captures
            WHERE capture_mode = 'blind' AND analysis_status = 'pending'
            ORDER BY created_at
            """
        ).fetchall()
    finally:
        conn.close()
    for capture_id, media_path, original_filename, media_type in rows:
        _queue_blind_analysis(capture_id, media_path, original_filename, media_type)
    if rows:
        logger.info("Re-queued %d pending blind capture(s) for analysis", len(rows))


@app.post("/collect/submit", status_code=202)
async def collect_capture(
    file: UploadFile = File(...),
    subject_id: Optional[str] = Form(None),
    name: str = Form("Unknown"),
    roll_no: str = Form(""),
    age: Optional[int] = Form(None),
    gender: str = Form(""),
    diet: str = Form("Unknown"),
) -> Dict[str, Any]:
    """Store the capture and queue it for analysis. The response deliberately carries no result."""
    name, diet = _validate_submission(file, name, age, diet)
    gender = _validate_gender(gender)
    roll_no = roll_no.strip()
    if not roll_no:
        raise HTTPException(status_code=422, detail="Roll No is required.")
    if len(roll_no) > 40:
        raise HTTPException(status_code=422, detail="Roll No must be at most 40 characters.")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    subject_id = _subject_id(subject_id)
    capture_id = f"cap_{uuid.uuid4().hex}"
    media_type = "video" if _is_video_file(file.filename) else "image"
    _register_subject(subject_id, name, age, diet, gender, roll_no)
    media_path = _store_media(contents, file.filename, subject_id, capture_id)
    _insert_pending_capture(media_type, file.filename, subject_id, capture_id, name, age, diet, media_path, roll_no, gender)
    _queue_blind_analysis(capture_id, media_path, file.filename, media_type)
    return {"status": "received", "subject_id": subject_id, "capture_id": capture_id}


@app.get("/export", include_in_schema=False)
def legacy_export_redirect() -> RedirectResponse:
    return RedirectResponse(url="/admin/export")


@app.get("/admin/export", dependencies=[Depends(_require_admin)])
def export_captures_excel() -> StreamingResponse:
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            """
            SELECT created_at, media_type, original_filename, subject_id, capture_id, name, roll_no, age, gender, diet,
                   emotion, confidence, valence, arousal, media_path, message, s3_url,
                   COALESCE(capture_mode, 'interactive'), COALESCE(analysis_status, 'done')
            FROM captures
            ORDER BY created_at DESC
            """
        ).fetchall()
    finally:
        conn.close()

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Captures"
    sheet.append([
        "Created At (UTC)", "Media Type", "Original Filename", "Subject ID", "Capture ID",
        "Name", "Roll No", "Age", "Gender", "Diet", "Emotion", "Confidence", "Valence", "Arousal", "Media Path",
        "Message", "S3 URL", "Capture Mode", "Analysis Status",
    ])
    for row in rows:
        sheet.append(list(row))

    for column_cells in sheet.columns:
        max_length = max((len(str(cell.value)) for cell in column_cells if cell.value is not None), default=10)
        sheet.column_dimensions[column_cells[0].column_letter].width = min(max_length + 2, 60)

    buffer = BytesIO()
    workbook.save(buffer)
    buffer.seek(0)

    filename = f"emotion_captures_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.xlsx"
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin", include_in_schema=False)
def admin_redirect() -> RedirectResponse:
    return RedirectResponse(url="/admin/")


@app.get("/admin/", include_in_schema=False, dependencies=[Depends(_require_admin)])
def admin_page() -> FileResponse:
    return FileResponse(os.path.join(ADMIN_DIR, "index.html"), headers={"Cache-Control": "no-store"})


@app.get("/admin/data", dependencies=[Depends(_require_admin)])
def admin_data() -> Dict[str, Any]:
    """Every subject and capture, with per-frame results parsed, for the admin dashboard."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        subjects = [dict(row) for row in conn.execute("SELECT * FROM subjects ORDER BY created_at")]
        rows = conn.execute(
            """
            SELECT id, created_at, media_type, original_filename, subject_id, capture_id, name, roll_no, age, gender,
                   diet,
                   emotion, confidence, valence, arousal, message, media_path, frame_results_json,
                   COALESCE(capture_mode, 'interactive') AS capture_mode,
                   COALESCE(analysis_status, 'done') AS analysis_status
            FROM captures
            ORDER BY created_at
            """
        ).fetchall()
    finally:
        conn.close()

    captures = []
    for row in rows:
        capture = dict(row)
        try:
            frames = json.loads(capture.pop("frame_results_json") or "[]")
        except ValueError:
            frames = []
        capture["frames"] = frames if isinstance(frames, list) else []
        capture["media_url"] = _media_url(capture.pop("media_path"))
        captures.append(capture)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "subjects": subjects,
        "captures": captures,
    }


@app.get("/admin/{filename}", include_in_schema=False, dependencies=[Depends(_require_admin)])
def admin_asset(filename: str):
    if filename == "thermal":  # thermal section of the dashboard (routes in thermal_api)
        return RedirectResponse(url="/admin/thermal/")
    if filename not in ADMIN_FILES:
        raise HTTPException(status_code=404, detail="Not found.")
    return FileResponse(os.path.join(ADMIN_DIR, filename), media_type=ADMIN_FILES[filename])


# ---------- Thermal + RGB page (/thermal/) ----------
# Separate routes and table (thermal_captures); the emotion-only flows above are unchanged.
import thermal_api  # noqa: E402

thermal_api.register(
    app,
    thermal_api.CoreDeps(
        db_path=DB_PATH,
        media_dir=MEDIA_DIR,
        backend_dir=os.path.dirname(os.path.abspath(__file__)),
        validate_submission=_validate_submission,
        validate_gender=_validate_gender,
        subject_id=_subject_id,
        register_subject=_register_subject,
        safe_component=_safe_component,
        media_url=_media_url,
        analyze_image=_analyze_image,
        require_admin=_require_admin,
        analyze_video=_analyze_video,
    ),
)


# Mounted last so it never shadows the API and /admin routes above.
@app.get("/", include_in_schema=False)
def root_redirect() -> RedirectResponse:
    # The interactive app lives at /capture/; the bare address goes to the data-collection page so a
    # partially typed URL never lands a participant on the page that shows results.
    return RedirectResponse(url="/collect/")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("emotion_api:app", host="0.0.0.0", port=8001, reload=False)
