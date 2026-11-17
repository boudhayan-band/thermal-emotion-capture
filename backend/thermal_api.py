"""Thermal + RGB capture endpoints, kept separate from the emotion-only /predict and /collect flows.

Routes
------
POST /thermal/predict        RGB photo (optional, for emotion) + thermal file (required) -> combined result
POST /thermal/predict_video  RGB video (optional) + thermal clip (.npz from thermal-agent) -> combined timeline
GET  /admin/thermal/         thermal section of the admin dashboard (admin)
GET  /admin/thermal/data     every thermal capture as JSON, with derived metrics (admin)
GET  /admin/thermal/export   Excel export with per-region temperatures and video frames (admin)

Thermal captures live in their own SQLite table, ``thermal_captures``; the existing ``captures``
table and the /predict, /collect and /admin dashboard behaviour are untouched. Shared pieces
(participant validation, subject registry, RGB emotion analysis, admin auth, media serving) are
passed in from emotion_api through ``register`` so nothing is duplicated.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sqlite3
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

import remote_api
import thermal_infer

logger = logging.getLogger("thermal_api")

THERMAL_MAP_SUFFIXES = {".npy", ".csv", ".txt"}
THERMAL_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}
RGB_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
TEMP_UNITS = {"C", "F", "K", "RAW64K"}
PAGES = {"thermal", "thermal-sync"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_VIDEO_UPLOAD_BYTES = 45 * 1024 * 1024
RGB_VIDEO_SUFFIXES = {".webm", ".mp4", ".mov", ".m4v"}
VIDEO_DURATIONS = {5, 10}
# Thermal clips are analysed on one frame every THERMAL_VIDEO_SAMPLE_SEC (about 0.4 s of CPU per frame).
THERMAL_VIDEO_SAMPLE_SEC = 0.5
THERMAL_VIDEO_MAX_SAMPLES = 24
# Per-frame landmark images and the landmark video are drawn at this upscale of the thermal frame.
FRAME_IMAGE_SCALE = 2
FRAME_IMAGE_JPEG_QUALITY = 85
# Inner-eye-corner temperature at or above this is flagged "elevated". Screening heuristic only:
# the TC01A is not a medical thermometer and readings depend on distance, emissivity and room.
ELEVATED_CANTHUS_C = 37.5
ADMIN_THERMAL_DIR = "admin_thermal"
ADMIN_THERMAL_FILES = {"thermal-admin.js": "application/javascript", "thermal-admin.css": "text/css"}
# Regions exported as columns (mean C) in the Excel sheet, in this order.
EXPORT_REGIONS = [
    "face", "forehead", "right_inner_canthus", "left_inner_canthus", "right_periorbital",
    "left_periorbital", "nose", "nose_tip", "right_cheek", "left_cheek", "mouth", "chin",
]


@dataclass
class CoreDeps:
    db_path: str
    media_dir: str
    backend_dir: str
    validate_submission: Callable[..., Tuple[str, str]]
    validate_gender: Callable[[str], str]
    subject_id: Callable[[Optional[str]], str]
    register_subject: Callable[..., None]
    safe_component: Callable[[str, str], str]
    media_url: Callable[[Optional[str]], Optional[str]]
    analyze_image: Callable[[str], Dict[str, Any]]
    require_admin: Callable[..., None]
    analyze_video: Optional[Callable[..., Dict[str, Any]]] = None


_deps: Optional[CoreDeps] = None
router = APIRouter()


# --------------------------------------------------------------------------- storage

# Added for the synced page (/thermal-sync/); older rows read as photo captures.
NEW_COLUMNS = {
    "capture_mode": "TEXT",           # 'photo' | 'video'
    "page": "TEXT",                   # 'thermal' | 'thermal-sync'
    "duration_sec": "REAL",           # video length requested
    "sync_offset_ms": "REAL",         # RGB recorder start minus thermal recording start
    "thermal_preview_path": "TEXT",   # colourised thermal clip (.webm), videos only
    "emotion_frames_json": "TEXT",    # per-frame emotion over the RGB video
    "thermal_frames_json": "TEXT",    # per-sample thermal readings over the clip
    # Remote phone camera (/thermal-remote/); NULL reads as the laptop camera.
    "rgb_source": "TEXT",             # 'laptop' | 'mobile'
    "rgb_device": "TEXT",             # phone model and camera, e.g. 'iPhone · Back Camera'
    "sync_skew_ms": "REAL",           # photo: RGB capture time minus thermal capture time (server clock)
    # Per-frame landmarks (video): {"range_c": [lo, hi], "frames": [{i, t, t_sync, box, pts}]}, one entry per
    # row of thermal_frames_json; pts are [x, y, occlusion_prob, temp_c] for the 68 landmarks.
    "frame_landmarks_json": "TEXT",
    "landmark_video_path": "TEXT",    # every thermal frame with its landmarks (.webm), videos only
}

def _init_table(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS thermal_captures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                capture_id TEXT NOT NULL UNIQUE,
                subject_id TEXT NOT NULL,
                name TEXT, age INTEGER, gender TEXT, diet TEXT,
                source TEXT,                 -- 'upload' | 'agent'
                device TEXT,                 -- free text, e.g. 'Fluke iSee TC01A'
                rgb_media_path TEXT,
                thermal_media_path TEXT,     -- original thermal upload
                temp_map_path TEXT,          -- normalised degrees C (.npy), when available
                overlay_path TEXT,           -- annotated PNG
                emotion TEXT, confidence REAL, valence REAL, arousal REAL, emotion_message TEXT,
                has_temperature INTEGER,
                temp_unit TEXT,
                face_box_json TEXT,
                occluded_count INTEGER,
                frame_temp_json TEXT,
                regions_json TEXT,
                landmarks_json TEXT,
                thermal_message TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_thermal_subject ON thermal_captures(subject_id)")
        existing = {row[1] for row in conn.execute("PRAGMA table_info(thermal_captures)")}
        for column, ddl in NEW_COLUMNS.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE thermal_captures ADD COLUMN {column} {ddl}")
        conn.commit()
    finally:
        conn.close()


def _store_bytes(contents: bytes, subject_id: str, capture_id: str, kind: str, suffix: str) -> str:
    d = _deps
    subject_dir = os.path.join(d.media_dir, d.safe_component(subject_id, "subject"))
    os.makedirs(subject_dir, exist_ok=True)
    stored = f"{d.safe_component(capture_id, 'capture')}_{kind}{suffix}"
    path = os.path.join(subject_dir, stored)
    with open(path, "wb") as fh:
        fh.write(contents)
    return os.path.relpath(path, d.backend_dir)


def _suffix(filename: Optional[str]) -> str:
    return os.path.splitext(filename or "")[1].lower()


# --------------------------------------------------------------------------- analysis

def _to_celsius(arr: np.ndarray, unit: str) -> np.ndarray:
    if unit == "F":
        arr = (arr - 32.0) * 5.0 / 9.0
    elif unit == "K":
        arr = arr - 273.15
    elif unit == "RAW64K":  # TC01A raw frames: uint16 in 1/64 K
        arr = arr / 64.0 - 273.15
    finite = arr[np.isfinite(arr)]
    median = float(np.median(finite)) if finite.size else float("nan")
    if not (-40.0 <= median <= 200.0):
        raise HTTPException(
            status_code=422,
            detail=f"The temperature map does not look like {unit} values (median {median:.1f} after "
                   "conversion to C). Check the temperature unit.",
        )
    return arr.astype(np.float32)


def _clean_ms(value: Optional[float]) -> Optional[float]:
    return round(float(value), 1) if value is not None and np.isfinite(value) and abs(value) <= 5000 else None


def _parse_face_box(value: Optional[str]) -> Optional[Tuple[int, int, int, int]]:
    if not value or not value.strip():
        return None
    try:
        parts = [int(round(float(p))) for p in value.replace(";", ",").split(",")]
    except ValueError:
        parts = []
    if len(parts) != 4 or parts[2] <= parts[0] or parts[3] <= parts[1] or min(parts) < 0:
        raise HTTPException(status_code=422, detail="face_box must be 'x0,y0,x1,y1' with x1>x0 and y1>y0.")
    return parts[0], parts[1], parts[2], parts[3]


def _run_emotion(rgb_bytes: Optional[bytes], rgb_suffix: str) -> Optional[Dict[str, Any]]:
    if not rgb_bytes:
        return None
    with tempfile.NamedTemporaryFile(delete=False, suffix=rgb_suffix or ".jpg") as tmp:
        tmp.write(rgb_bytes)
        path = tmp.name
    try:
        return _deps.analyze_image(path)
    finally:
        os.remove(path)


def _run_thermal(thermal_bytes: bytes, thermal_name: str, unit: str,
                 face_box: Optional[Tuple[int, int, int, int]]) -> Tuple[Dict[str, Any], Optional[np.ndarray]]:
    suffix = _suffix(thermal_name)
    temp_c = None
    image_gray = None
    if suffix in THERMAL_MAP_SUFFIXES:
        try:
            raw = thermal_infer.load_temperature_map(thermal_bytes, thermal_name)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        temp_c = _to_celsius(raw, unit)
    else:
        try:
            image_gray = thermal_infer.decode_image_gray(thermal_bytes)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if face_box is not None:
        h, w = (temp_c if temp_c is not None else image_gray).shape
        if face_box[2] >= w or face_box[3] >= h:
            raise HTTPException(status_code=422, detail=f"face_box is outside the {w}x{h} thermal frame.")
    result = thermal_infer.analyze(temp_c=temp_c, image_gray=image_gray, face_box=face_box)
    return result, temp_c


def _thermal_message(result: Dict[str, Any]) -> str:
    parts = []
    src = result["face_box"]["source"]
    parts.append({
        "provided": "Face box provided.",
        "auto_skin_temperature": "Face found automatically from skin temperature.",
        "auto_bright_region": "Face found automatically as the brightest region (no temperature data).",
        "full_frame": "No face region found; the whole frame was analysed.",
    }.get(src, ""))
    if not result["has_temperature"]:
        parts.append("Upload a temperature map (.npy / .csv) to get temperatures.")
    return " ".join(p for p in parts if p)


# --------------------------------------------------------------------------- derived metrics

def _r(regions: Optional[Dict[str, Any]], key: str, field: str = "mean_c") -> Optional[float]:
    value = ((regions or {}).get(key) or {}).get(field)
    return float(value) if value is not None else None


def _diff(a: Optional[float], b: Optional[float]) -> Optional[float]:
    return round(a - b, 2) if a is not None and b is not None else None


def _avg(values: List[Optional[float]]) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return round(float(np.mean(vals)), 2) if vals else None


def derived_metrics(regions: Optional[Dict[str, Any]], occluded_count: Optional[int],
                    box_source: Optional[str], has_temperature: bool) -> Dict[str, Any]:
    """Summary indicators computed from the region temperatures of one capture.

    - canthus_max_c: warmest inner eye corner; the usual proxy for core temperature in thermal screening.
    - canthus / cheek asymmetry: right minus left (subject's sides); large values usually mean a
      turned head or an occlusion rather than physiology.
    - nose_forehead_delta_c: nose tip minus forehead. The nose tip cools with sympathetic arousal
      (stress), so a more negative value is often read as higher arousal.
    - quality: how far the readings can be trusted (temperature map present, face found, few occlusions).
    """
    canthus = [v for v in (_r(regions, "right_inner_canthus", "max_c"), _r(regions, "left_inner_canthus", "max_c"))
               if v is not None]
    canthus_max = round(max(canthus), 2) if canthus else None
    if not has_temperature:
        quality = "no_temperature"
    elif box_source == "full_frame" or (occluded_count or 0) > 34:
        quality = "poor"
    elif (occluded_count or 0) > 12:
        quality = "fair"
    else:
        quality = "good"
    return {
        "face_mean_c": _r(regions, "face"),
        "face_max_c": _r(regions, "face", "max_c"),
        "forehead_mean_c": _r(regions, "forehead"),
        "canthus_max_c": canthus_max,
        "periorbital_mean_c": _avg([_r(regions, "right_periorbital"), _r(regions, "left_periorbital")]),
        "nose_tip_c": _r(regions, "nose_tip"),
        "canthus_asymmetry_c": _diff(_r(regions, "right_inner_canthus"), _r(regions, "left_inner_canthus")),
        "cheek_asymmetry_c": _diff(_r(regions, "right_cheek"), _r(regions, "left_cheek")),
        "nose_forehead_delta_c": _diff(_r(regions, "nose_tip"), _r(regions, "forehead")),
        "elevated_temp": (canthus_max >= ELEVATED_CANTHUS_C) if canthus_max is not None else None,
        "quality": quality,
    }


# --------------------------------------------------------------------------- video

def _load_thermal_clip(data: bytes) -> Tuple[np.ndarray, np.ndarray]:
    """Read a thermal-agent clip: .npz with ``frames`` (N x H x W), ``t`` (s) and optional ``scale``."""
    try:
        with np.load(BytesIO(data), allow_pickle=False) as z:
            if "frames" not in z.files:
                raise ValueError("missing 'frames'")
            frames = np.asarray(z["frames"])
            scale = float(z["scale"]) if "scale" in z.files else 1.0
            t = np.asarray(z["t"], dtype=np.float64) if "t" in z.files else None
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"The thermal clip could not be read ({exc}). "
                                                    "It must be the .npz recorded by thermal-agent.") from exc
    if frames.ndim != 3 or not (1 <= frames.shape[0] <= 600) or not (16 <= frames.shape[1] <= 1024) \
            or not (16 <= frames.shape[2] <= 1024):
        raise HTTPException(status_code=422, detail=f"Unexpected thermal clip shape {frames.shape}.")
    if t is None or t.shape != (frames.shape[0],):
        t = np.arange(frames.shape[0], dtype=np.float64) / 10.0
    temp = _to_celsius(frames.astype(np.float32) * np.float32(scale), "C")
    return temp, t - t[0]


def _sample_indices(t: np.ndarray) -> List[int]:
    targets = np.arange(0.0, float(t[-1]) + 1e-6, THERMAL_VIDEO_SAMPLE_SEC)
    idx = sorted({int(np.argmin(np.abs(t - target))) for target in targets})
    if len(idx) > THERMAL_VIDEO_MAX_SAMPLES:
        idx = [idx[int(round(i))] for i in np.linspace(0, len(idx) - 1, THERMAL_VIDEO_MAX_SAMPLES)]
    return idx or [0]


def _aggregate_regions(samples: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Per region over the clip: mean of the sample means, extremes, spread and trend."""
    out: Dict[str, Dict[str, Any]] = {}
    for key, spec in thermal_infer.REGIONS.items():
        ts, means, mins, maxs, occl = [], [], [], [], []
        for s in samples:
            reg = (s.get("regions") or {}).get(key) or {}
            occl.append(reg.get("occluded_fraction", 0.0))
            if reg.get("mean_c") is not None:
                ts.append(s["t"])
                means.append(reg["mean_c"])
                mins.append(reg["min_c"])
                maxs.append(reg["max_c"])
        entry: Dict[str, Any] = {"label": spec["label"], "samples": len(means),
                                 "occluded_fraction": round(float(np.mean(occl)), 3) if occl else 0.0}
        if means:
            slope = None
            if len(means) >= 3 and ts[-1] - ts[0] >= 1.0:
                slope = round(float(np.polyfit(ts, means, 1)[0]) * 60.0, 3)
            entry.update({
                "mean_c": round(float(np.mean(means)), 2),
                "median_c": round(float(np.median(means)), 2),
                "min_c": round(float(np.min(mins)), 2),
                "max_c": round(float(np.max(maxs)), 2),
                "std_c": round(float(np.std(means)), 3),
                "change_c": round(means[-1] - means[0], 2),
                "slope_c_per_min": slope,
            })
        else:
            entry.update({"mean_c": None, "median_c": None, "min_c": None, "max_c": None,
                          "std_c": None, "change_c": None, "slope_c_per_min": None})
        out[key] = entry
    return out


def _thermal_preview_webm(temp: np.ndarray, t: np.ndarray) -> bytes:
    """Colourised clip for playback in the browser (best effort; VP8 WebM)."""
    finite = temp[np.isfinite(temp)]
    if not finite.size:
        return b""
    lo, hi = float(np.percentile(finite, 1)), float(np.percentile(finite, 99.5))
    fps = max(1.0, min(30.0, (len(t) - 1) / float(t[-1]))) if len(t) > 1 and t[-1] > 0 else 10.0
    h, w = temp.shape[1:]
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        path = tmp.name
    try:
        import cv2

        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"VP80"), fps, (w * 2, h * 2))
        if not writer.isOpened():
            return b""
        for frame in temp:
            gray = (np.clip((np.nan_to_num(frame, nan=lo) - lo) / max(hi - lo, 0.1), 0, 1) * 255).astype(np.uint8)
            color = cv2.applyColorMap(gray, cv2.COLORMAP_INFERNO)
            writer.write(cv2.resize(color, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC))
        writer.release()
        with open(path, "rb") as fh:
            return fh.read()
    except Exception:
        logger.exception("Could not encode the thermal preview clip")
        return b""
    finally:
        os.remove(path)


def _overlay_range(temp: np.ndarray, results: List[Dict[str, Any]]) -> Tuple[float, float]:
    """One colour scale for every landmark image of a clip: 1st-99th percentile of the face boxes."""
    vals = []
    for frame, res in zip(temp, results):
        b = res["face_box"]
        crop = frame[b["y0"]:b["y1"] + 1, b["x0"]:b["x1"] + 1]
        vals.append(crop[np.isfinite(crop)])
    finite = np.concatenate(vals) if vals else np.array([], dtype=np.float32)
    if not finite.size:
        finite = temp[np.isfinite(temp)]
    if not finite.size:
        return 0.0, 1.0
    lo, hi = float(np.percentile(finite, 1)), float(np.percentile(finite, 99))
    return round(lo, 2), round(max(hi, lo + 0.1), 2)


def _compact_landmarks(res: Dict[str, Any], i: int, t: np.ndarray, offset_s: float) -> Dict[str, Any]:
    b = res["face_box"]
    return {
        "i": int(i),
        "t": round(float(t[i]), 2),
        "t_sync": round(float(t[i]) - offset_s, 2),
        "box": [b["x0"], b["y0"], b["x1"], b["y1"]],
        "pts": [[l["x"], l["y"], l["occlusion_prob"], l["temp_c"]] for l in res["landmarks"]],
    }


def _expand_landmarks(entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    thr = thermal_infer.OCCLUSION_THRESHOLD
    return [{"index": k, "x": x, "y": y, "occlusion_prob": p, "occluded": p >= thr, "temp_c": tc}
            for k, (x, y, p, tc) in enumerate(entry["pts"])]


def _render_frame(frame: np.ndarray, entry: Dict[str, Any], range_c: Sequence[float],
                  label: Optional[str] = None) -> np.ndarray:
    """BGR landmark image of one thermal frame from its compact landmark entry."""
    gray = thermal_infer.render_gray(frame, float(range_c[0]), float(range_c[1]))
    pts = np.asarray(entry["pts"], dtype=np.float64)
    return thermal_infer.draw_overlay_bgr(gray, entry["box"], pts[:, :2], pts[:, 2], FRAME_IMAGE_SCALE, label)


def _jpeg(bgr: np.ndarray) -> bytes:
    import cv2

    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), FRAME_IMAGE_JPEG_QUALITY])
    return buf.tobytes() if ok else b""


def _frame_label(entry: Dict[str, Any]) -> str:
    occluded = sum(1 for p in entry["pts"] if p[2] >= thermal_infer.OCCLUSION_THRESHOLD)
    return f"t = {entry['t_sync']:.1f} s   occluded {occluded}/68"


def _landmark_video_webm(temp: np.ndarray, t: np.ndarray, entries: List[Dict[str, Any]],
                         range_c: Sequence[float]) -> bytes:
    """Every thermal frame with its own landmarks, at the clip's frame rate (VP8 WebM, best effort)."""
    if not entries:
        return b""
    fps = max(1.0, min(30.0, (len(t) - 1) / float(t[-1]))) if len(t) > 1 and t[-1] > 0 else 10.0
    h, w = temp.shape[1:]
    size = (w * FRAME_IMAGE_SCALE, h * FRAME_IMAGE_SCALE)
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        path = tmp.name
    try:
        import cv2

        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"VP80"), fps, size)
        if not writer.isOpened():
            return b""
        for entry in entries:
            writer.write(_render_frame(temp[entry["i"]], entry, range_c, _frame_label(entry)))
        writer.release()
        with open(path, "rb") as fh:
            return fh.read()
    except Exception:
        logger.exception("Could not encode the landmark video")
        return b""
    finally:
        os.remove(path)


def _run_thermal_video(clip_bytes: bytes, offset_ms: float) -> Dict[str, Any]:
    temp, t = _load_thermal_clip(clip_bytes)
    offset_s = offset_ms / 1000.0
    # Landmarks on every frame (for the landmark video); statistics use one frame every 0.5 s as before.
    all_res = thermal_infer.analyze_many(list(temp))
    sample_idx = _sample_indices(t)
    samples: List[Dict[str, Any]] = []
    for i in sample_idx:
        res = all_res[i]
        regions = {k: {f: v.get(f) for f in ("mean_c", "min_c", "max_c", "occluded_fraction")}
                   for k, v in (res.get("regions") or {}).items()}
        samples.append({
            "t": round(float(t[i]), 2),
            # On the RGB video's clock (the RGB recorder started offset_s after the thermal recording).
            "t_sync": round(float(t[i]) - offset_s, 2),
            "face_box": res["face_box"],
            "occluded_count": res["occluded_count"],
            "frame_temp_c": res.get("frame_temp_c"),
            "regions": regions,
            "derived": derived_metrics(regions, res["occluded_count"], res["face_box"]["source"], True),
        })
    # Representative frame for the overlay / landmark table: fewest occlusions, nearest the middle.
    mid = float(t[-1]) / 2.0
    rep_i = min(sample_idx, key=lambda i: (all_res[i]["occluded_count"], abs(float(t[i]) - mid)))
    rep = thermal_infer.analyze(temp_c=temp[rep_i], want_overlay=True)
    regions = _aggregate_regions(samples)
    finite = temp[np.isfinite(temp)]
    occluded_mean = int(round(float(np.mean([s["occluded_count"] for s in samples]))))
    face_sources = [s["face_box"]["source"] for s in samples]
    box_source = max(set(face_sources), key=face_sources.count)

    range_c = _overlay_range(temp, all_res)
    every = [_compact_landmarks(res, i, t, offset_s) for i, res in enumerate(all_res)]
    sampled = [every[i] for i in sample_idx]
    frame_images = [_jpeg(_render_frame(temp[e["i"]], e, range_c)) for e in sampled]
    return {
        "model": rep["model"],
        "image_size": rep["image_size"],
        "face_box": {**rep["face_box"], "source": box_source},
        "landmarks": rep["landmarks"],
        "representative_t": round(float(t[rep_i]), 2),
        "occluded_count": occluded_mean,
        "occlusion_threshold": rep["occlusion_threshold"],
        "has_temperature": True,
        "frame_temp_c": {"min": round(float(finite.min()), 2), "max": round(float(finite.max()), 2),
                         "mean": round(float(finite.mean()), 2)},
        "regions": regions,
        "frames": samples,
        "clip": {"frames": int(temp.shape[0]), "seconds": round(float(t[-1]), 2),
                 "fps": round((temp.shape[0] - 1) / float(t[-1]), 1) if t[-1] > 0 else None,
                 "sampled": len(samples), "sample_interval_s": THERMAL_VIDEO_SAMPLE_SEC},
        "_overlay_png": rep["_overlay_png"],
        "_preview_webm": _thermal_preview_webm(temp, t),
        "_frame_landmarks": {"range_c": list(range_c), "frames": sampled},
        "_frame_images": frame_images,
        "_landmark_webm": _landmark_video_webm(temp, t, every, range_c),
        "_temp": temp,
        "_t": t,
    }


def _run_emotion_video(video_bytes: Optional[bytes], suffix: str, seconds: float) -> Optional[Dict[str, Any]]:
    if not video_bytes:
        return None
    if _deps.analyze_video is None:
        return {"emotion": "Unknown", "confidence": 0.0, "message": "Video emotion analysis is not available."}
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or ".webm") as tmp:
        tmp.write(video_bytes)
        path = tmp.name
    try:
        # A little slack so the last frames of a clip that runs slightly long are still counted.
        result = _deps.analyze_video(path, max_seconds=seconds + 0.5)
        if isinstance(result.get("message"), str):
            result["message"] = result["message"].replace(f"{seconds + 0.5:g} second", f"{seconds:g} second")
        return result
    finally:
        os.remove(path)


# --------------------------------------------------------------------------- routes

@router.post("/thermal/predict")
async def thermal_predict(
    thermal_file: UploadFile = File(...),
    rgb_file: Optional[UploadFile] = File(None),
    subject_id: Optional[str] = Form(None),
    name: str = Form("Unknown"),
    age: Optional[int] = Form(None),
    gender: str = Form(""),
    diet: str = Form("Unknown"),
    temp_unit: str = Form("C"),
    face_box: Optional[str] = Form(None),
    source: str = Form("upload"),
    device: str = Form(""),
    page: str = Form("thermal"),
    remote_token: Optional[str] = Form(None),
    remote_upload: Optional[str] = Form(None),
    sync_skew_ms: Optional[float] = Form(None),
) -> Dict[str, Any]:
    d = _deps
    name, diet = d.validate_submission(thermal_file, name, age, diet)
    page = page if page in PAGES else "thermal"
    gender = d.validate_gender(gender)
    unit = temp_unit.strip().upper()
    if unit not in TEMP_UNITS:
        raise HTTPException(status_code=422, detail=f"temp_unit must be one of {sorted(TEMP_UNITS)}.")
    source = source if source in {"upload", "agent"} else "upload"
    box = _parse_face_box(face_box)

    t_suffix = _suffix(thermal_file.filename)
    if t_suffix not in THERMAL_MAP_SUFFIXES | THERMAL_IMAGE_SUFFIXES:
        raise HTTPException(status_code=422, detail="Thermal file must be .npy, .csv or an image (.jpg/.png/.tif).")
    thermal_bytes = await thermal_file.read()
    if not thermal_bytes:
        raise HTTPException(status_code=400, detail="The thermal file is empty.")

    rgb_bytes = None
    r_suffix = ""
    if rgb_file is not None and rgb_file.filename:
        r_suffix = _suffix(rgb_file.filename) or ".jpg"
        if r_suffix not in RGB_SUFFIXES:
            raise HTTPException(status_code=422, detail="RGB file must be a .jpg, .png or .webp photo.")
        rgb_bytes = await rgb_file.read() or None
    rgb_source, rgb_device = "laptop", None
    if remote_upload and rgb_bytes is None:  # photo taken by the paired phone
        rgb_bytes, r_suffix, meta = remote_api.take_upload(remote_token, remote_upload, "photo")
        if r_suffix not in RGB_SUFFIXES:
            raise HTTPException(status_code=422, detail="The phone photo must be .jpg, .png or .webp.")
        rgb_source, rgb_device = "mobile", meta["device"]
    sync_skew_ms = _clean_ms(sync_skew_ms)
    for label, blob in (("Thermal", thermal_bytes), ("RGB", rgb_bytes)):
        if blob and len(blob) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"{label} file is larger than 25 MB.")

    subject_id = d.subject_id(subject_id)
    capture_id = f"thc_{uuid.uuid4().hex}"
    d.register_subject(subject_id, name, age, diet, gender)

    # CPU-heavy work off the event loop so other requests keep being served.
    emotion = await run_in_threadpool(_run_emotion, rgb_bytes, r_suffix)
    try:
        thermal, temp_c = await run_in_threadpool(_run_thermal, thermal_bytes, thermal_file.filename, unit, box)
    except HTTPException:
        raise
    except Exception as exc:  # keep the service usable; report the failure
        logger.exception("Thermal analysis failed for %s", capture_id)
        raise HTTPException(status_code=500, detail=f"Thermal analysis failed: {exc}") from exc

    overlay_png = thermal.pop("_overlay_png", b"")
    rgb_path = _store_bytes(rgb_bytes, subject_id, capture_id, "rgb", r_suffix) if rgb_bytes else None
    thermal_path = _store_bytes(thermal_bytes, subject_id, capture_id, "thermal", t_suffix)
    temp_map_path = None
    if temp_c is not None:
        buf = BytesIO()
        np.save(buf, temp_c)
        temp_map_path = _store_bytes(buf.getvalue(), subject_id, capture_id, "temp_c", ".npy")
    overlay_path = _store_bytes(overlay_png, subject_id, capture_id, "overlay", ".png") if overlay_png else None
    message = _thermal_message(thermal)

    conn = sqlite3.connect(d.db_path)
    try:
        conn.execute(
            """
            INSERT INTO thermal_captures
                (created_at, capture_id, subject_id, name, age, gender, diet, source, device,
                 rgb_media_path, thermal_media_path, temp_map_path, overlay_path,
                 emotion, confidence, valence, arousal, emotion_message,
                 has_temperature, temp_unit, face_box_json, occluded_count, frame_temp_json,
                 regions_json, landmarks_json, thermal_message, capture_mode, page,
                 rgb_source, rgb_device, sync_skew_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'photo', ?, ?, ?, ?)
            """,
            (
                datetime.now(timezone.utc).isoformat(), capture_id, subject_id, name, age, gender, diet,
                source, device.strip()[:80] or None,
                rgb_path, thermal_path, temp_map_path, overlay_path,
                (emotion or {}).get("emotion"), (emotion or {}).get("confidence"),
                (emotion or {}).get("valence"), (emotion or {}).get("arousal"), (emotion or {}).get("message"),
                int(thermal["has_temperature"]), unit if temp_c is not None else None,
                json.dumps(thermal["face_box"]), thermal["occluded_count"],
                json.dumps(thermal.get("frame_temp_c")) if thermal.get("frame_temp_c") else None,
                json.dumps(thermal.get("regions")) if thermal.get("regions") else None,
                json.dumps(thermal["landmarks"]), message, page,
                rgb_source, rgb_device, sync_skew_ms,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    if remote_upload:
        remote_api.release_upload(remote_token, remote_upload)

    thermal["message"] = message
    thermal["derived"] = derived_metrics(thermal.get("regions"), thermal["occluded_count"],
                                         thermal["face_box"]["source"], thermal["has_temperature"])
    thermal["overlay"] = "data:image/png;base64," + base64.b64encode(overlay_png).decode("ascii") if overlay_png else None
    return {
        "capture_id": capture_id,
        "subject_id": subject_id,
        "name": name, "age": age, "gender": gender, "diet": diet,
        "source": source,
        "rgb_source": rgb_source, "rgb_device": rgb_device, "sync_skew_ms": sync_skew_ms,
        "emotion": emotion,
        "thermal": thermal,
        "media": {
            "rgb_url": d.media_url(rgb_path),
            "thermal_url": d.media_url(thermal_path),
            "temp_map_url": d.media_url(temp_map_path),
            "overlay_url": d.media_url(overlay_path),
        },
    }


@router.post("/thermal/predict_video")
async def thermal_predict_video(
    thermal_clip: UploadFile = File(...),
    rgb_video: Optional[UploadFile] = File(None),
    subject_id: Optional[str] = Form(None),
    name: str = Form("Unknown"),
    age: Optional[int] = Form(None),
    gender: str = Form(""),
    diet: str = Form("Unknown"),
    duration: int = Form(5),
    sync_offset_ms: float = Form(0.0),
    device: str = Form(""),
    page: str = Form("thermal-sync"),
    remote_token: Optional[str] = Form(None),
    remote_upload: Optional[str] = Form(None),
) -> Dict[str, Any]:
    """RGB video (emotion over time) + thermal clip recorded at the same moment (temperatures over time)."""
    d = _deps
    name, diet = d.validate_submission(thermal_clip, name, age, diet)
    gender = d.validate_gender(gender)
    page = page if page in PAGES else "thermal-sync"
    if duration not in VIDEO_DURATIONS:
        raise HTTPException(status_code=422, detail=f"duration must be one of {sorted(VIDEO_DURATIONS)} seconds.")
    if not np.isfinite(sync_offset_ms) or abs(sync_offset_ms) > 5000:
        sync_offset_ms = 0.0
    if _suffix(thermal_clip.filename) != ".npz":
        raise HTTPException(status_code=422, detail="The thermal clip must be the .npz recorded by thermal-agent.")
    clip_bytes = await thermal_clip.read()
    if not clip_bytes:
        raise HTTPException(status_code=400, detail="The thermal clip is empty.")

    video_bytes = None
    v_suffix = ""
    if rgb_video is not None and rgb_video.filename:
        v_suffix = _suffix(rgb_video.filename) or ".webm"
        if v_suffix not in RGB_VIDEO_SUFFIXES:
            raise HTTPException(status_code=422, detail="RGB video must be .webm, .mp4 or .mov.")
        video_bytes = await rgb_video.read() or None
    rgb_source, rgb_device = "laptop", None
    if remote_upload and video_bytes is None:  # video recorded by the paired phone
        video_bytes, v_suffix, meta = remote_api.take_upload(remote_token, remote_upload, "video")
        if v_suffix not in RGB_VIDEO_SUFFIXES:
            raise HTTPException(status_code=422, detail="The phone video must be .webm, .mp4 or .mov.")
        rgb_source, rgb_device = "mobile", meta["device"]
    for label, blob in (("Thermal clip", clip_bytes), ("RGB video", video_bytes)):
        if blob and len(blob) > MAX_VIDEO_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"{label} is larger than 45 MB.")

    subject_id = d.subject_id(subject_id)
    capture_id = f"thv_{uuid.uuid4().hex}"
    d.register_subject(subject_id, name, age, diet, gender)

    # Emotion (PyTorch) and thermal (TensorFlow) run side by side in the thread pool.
    emotion_task = run_in_threadpool(_run_emotion_video, video_bytes, v_suffix, float(duration))
    thermal_task = run_in_threadpool(_run_thermal_video, clip_bytes, sync_offset_ms)
    results = await asyncio.gather(emotion_task, thermal_task, return_exceptions=True)
    emotion, thermal = results
    if isinstance(thermal, HTTPException):
        raise thermal
    if isinstance(thermal, BaseException):
        logger.error("Thermal video analysis failed for %s", capture_id, exc_info=thermal)
        raise HTTPException(status_code=500, detail=f"Thermal analysis failed: {thermal}")
    if isinstance(emotion, BaseException):
        logger.error("Video emotion analysis failed for %s", capture_id, exc_info=emotion)
        emotion = {"emotion": "Unknown", "confidence": 0.0, "message": f"Inference failed: {emotion}"}

    overlay_png = thermal.pop("_overlay_png", b"")
    preview_webm = thermal.pop("_preview_webm", b"")
    frame_landmarks = thermal.pop("_frame_landmarks")
    frame_images = thermal.pop("_frame_images")
    landmark_webm = thermal.pop("_landmark_webm", b"")
    temp = thermal.pop("_temp")
    t = thermal.pop("_t")
    rgb_path = _store_bytes(video_bytes, subject_id, capture_id, "rgb", v_suffix) if video_bytes else None
    thermal_path = _store_bytes(clip_bytes, subject_id, capture_id, "thermal", ".npz")
    del temp, t  # the stored clip already holds every frame (degrees C x scale)
    temp_map_path = None
    overlay_path = _store_bytes(overlay_png, subject_id, capture_id, "overlay", ".png") if overlay_png else None
    preview_path = _store_bytes(preview_webm, subject_id, capture_id, "thermal_preview", ".webm") if preview_webm else None
    landmark_video_path = (_store_bytes(landmark_webm, subject_id, capture_id, "landmarks", ".webm")
                           if landmark_webm else None)
    message = _thermal_message(thermal) + (
        f" {thermal['clip']['sampled']} of {thermal['clip']['frames']} thermal frames analysed "
        f"(one every {THERMAL_VIDEO_SAMPLE_SEC:g} s); overlay from t = {thermal['representative_t']:.1f} s."
    )
    emotion_frames = [{k: v for k, v in f.items() if k != "image"} for f in (emotion or {}).get("frames") or []]

    conn = sqlite3.connect(d.db_path)
    try:
        conn.execute(
            """
            INSERT INTO thermal_captures
                (created_at, capture_id, subject_id, name, age, gender, diet, source, device,
                 rgb_media_path, thermal_media_path, temp_map_path, overlay_path,
                 emotion, confidence, valence, arousal, emotion_message,
                 has_temperature, temp_unit, face_box_json, occluded_count, frame_temp_json,
                 regions_json, landmarks_json, thermal_message,
                 capture_mode, page, duration_sec, sync_offset_ms, thermal_preview_path,
                 emotion_frames_json, thermal_frames_json, rgb_source, rgb_device,
                 frame_landmarks_json, landmark_video_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'C', ?, ?, ?, ?, ?, ?,
                    'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                datetime.now(timezone.utc).isoformat(), capture_id, subject_id, name, age, gender, diet,
                device.strip()[:80] or None,
                rgb_path, thermal_path, temp_map_path, overlay_path,
                (emotion or {}).get("emotion"), (emotion or {}).get("confidence"),
                (emotion or {}).get("valence"), (emotion or {}).get("arousal"), (emotion or {}).get("message"),
                json.dumps(thermal["face_box"]), thermal["occluded_count"], json.dumps(thermal["frame_temp_c"]),
                json.dumps(thermal["regions"]), json.dumps(thermal["landmarks"]), message,
                page, float(duration), sync_offset_ms, preview_path,
                json.dumps(emotion_frames) if emotion_frames else None, json.dumps(thermal["frames"]),
                rgb_source, rgb_device,
                json.dumps(frame_landmarks), landmark_video_path,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    if remote_upload:
        remote_api.release_upload(remote_token, remote_upload)

    thermal["message"] = message
    thermal["derived"] = derived_metrics(thermal["regions"], thermal["occluded_count"],
                                         thermal["face_box"]["source"], True)
    thermal["overlay"] = "data:image/png;base64," + base64.b64encode(overlay_png).decode("ascii") if overlay_png else None
    # The capture page has no admin login, so per-frame images and the landmark video travel inline.
    for frame, entry, jpg in zip(thermal["frames"], frame_landmarks["frames"], frame_images):
        frame["landmarks"] = _expand_landmarks(entry)
        frame["image"] = "data:image/jpeg;base64," + base64.b64encode(jpg).decode("ascii") if jpg else None
    thermal["landmark_video"] = ("data:video/webm;base64," + base64.b64encode(landmark_webm).decode("ascii")
                                 if landmark_webm else None)
    return {
        "capture_id": capture_id,
        "subject_id": subject_id,
        "name": name, "age": age, "gender": gender, "diet": diet,
        "mode": "video",
        "duration": duration,
        "sync_offset_ms": sync_offset_ms,
        "rgb_source": rgb_source, "rgb_device": rgb_device,
        "emotion": emotion,
        "thermal": thermal,
        "media": {
            "rgb_url": d.media_url(rgb_path),
            "thermal_url": d.media_url(thermal_path),
            "temp_map_url": d.media_url(temp_map_path),
            "overlay_url": d.media_url(overlay_path),
            "thermal_preview_url": d.media_url(preview_path),
            "landmark_video_url": d.media_url(landmark_video_path),
        },
    }


def _rows(order: str = "ASC") -> List[Dict[str, Any]]:
    conn = sqlite3.connect(_deps.db_path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(f"SELECT * FROM thermal_captures ORDER BY created_at {order}")]
    finally:
        conn.close()


JSON_COLUMNS = ("face_box_json", "frame_temp_json", "regions_json", "landmarks_json",
                "emotion_frames_json", "thermal_frames_json")
PATH_COLUMNS = {"rgb_media_path": "rgb_url", "thermal_media_path": "thermal_url", "temp_map_path": "temp_map_url",
                "overlay_path": "overlay_url", "thermal_preview_path": "thermal_preview_url",
                "landmark_video_path": "landmark_video_url"}


def _parsed_row(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    # Per-frame landmarks are large; the dashboard fetches them per capture from /admin/thermal/frames/.
    out.pop("frame_landmarks_json", None)
    for key in JSON_COLUMNS:
        raw = out.pop(key, None)
        try:
            out[key[:-5]] = json.loads(raw) if raw else None
        except ValueError:
            out[key[:-5]] = None
    for key, url_key in PATH_COLUMNS.items():
        out[url_key] = _deps.media_url(out.pop(key, None))
    out["capture_mode"] = out.get("capture_mode") or "photo"
    out["page"] = out.get("page") or "thermal"
    out["rgb_source"] = out.get("rgb_source") or "laptop"
    box = out.get("face_box") or {}
    out["derived"] = derived_metrics(out.get("regions"), out.get("occluded_count"), box.get("source"),
                                     bool(out.get("has_temperature")))
    return out


# --------------------------------------------------------------------------- per-frame landmarks (admin)

def _video_row(capture_id: str) -> Dict[str, Any]:
    conn = sqlite3.connect(_deps.db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM thermal_captures WHERE capture_id = ?", (capture_id,)).fetchone()
    finally:
        conn.close()
    if row is None or row["capture_mode"] != "video" or not row["thermal_media_path"]:
        raise HTTPException(status_code=404, detail="Video capture not found.")
    return dict(row)


def _stored_clip(row: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray]:
    path = os.path.join(_deps.backend_dir, row["thermal_media_path"])
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="The thermal clip file is missing.")
    with open(path, "rb") as fh:
        return _load_thermal_clip(fh.read())


def _update_row(capture_id: str, **values: Any) -> None:
    conn = sqlite3.connect(_deps.db_path)
    try:
        sets = ", ".join(f"{k} = ?" for k in values)
        conn.execute(f"UPDATE thermal_captures SET {sets} WHERE capture_id = ?", (*values.values(), capture_id))
        conn.commit()
    finally:
        conn.close()


def _frame_landmarks_for(row: Dict[str, Any], temp: Optional[np.ndarray] = None,
                         t: Optional[np.ndarray] = None) -> Dict[str, Any]:
    """Stored per-frame landmarks; captures made before they were stored are analysed once and saved."""
    if row.get("frame_landmarks_json"):
        try:
            return json.loads(row["frame_landmarks_json"])
        except ValueError:
            pass
    if temp is None:
        temp, t = _stored_clip(row)
    frames = json.loads(row["thermal_frames_json"] or "[]")
    idx = [int(np.argmin(np.abs(t - float(f["t"])))) for f in frames] or _sample_indices(t)
    offset_s = float(row.get("sync_offset_ms") or 0.0) / 1000.0
    results = thermal_infer.analyze_many([temp[i] for i in idx])
    data = {"range_c": list(_overlay_range(temp[idx], results)),
            "frames": [_compact_landmarks(res, i, t, offset_s) for i, res in zip(idx, results)]}
    _update_row(row["capture_id"], frame_landmarks_json=json.dumps(data))
    return data


def _build_admin_routes(require_admin: Callable[..., None]) -> APIRouter:
    admin = APIRouter(dependencies=[Depends(require_admin)])
    admin_dir = os.path.join(_deps.backend_dir, ADMIN_THERMAL_DIR)

    @admin.get("/admin/thermal", include_in_schema=False)
    def thermal_admin_redirect() -> RedirectResponse:
        return RedirectResponse(url="/admin/thermal/")

    @admin.get("/admin/thermal/", include_in_schema=False)
    def thermal_admin_page() -> FileResponse:
        return FileResponse(os.path.join(admin_dir, "index.html"), headers={"Cache-Control": "no-store"})

    @admin.get("/admin/thermal/assets/{filename}", include_in_schema=False)
    def thermal_admin_asset(filename: str) -> FileResponse:
        if filename not in ADMIN_THERMAL_FILES:
            raise HTTPException(status_code=404, detail="Not found.")
        return FileResponse(os.path.join(admin_dir, filename), media_type=ADMIN_THERMAL_FILES[filename])

    @admin.get("/admin/thermal/data")
    def thermal_data() -> Dict[str, Any]:
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "regions": {k: v["label"] for k, v in thermal_infer.REGIONS.items()},
            "elevated_canthus_c": ELEVATED_CANTHUS_C,
            "captures": [_parsed_row(row) for row in _rows()],
        }

    @admin.get("/admin/thermal/export")
    def thermal_export() -> StreamingResponse:
        from openpyxl import Workbook

        wb = Workbook()
        sheet = wb.active
        sheet.title = "Thermal captures"
        region_labels = [thermal_infer.REGIONS[k]["label"] for k in EXPORT_REGIONS]
        derived_cols = [
            ("canthus_max_c", "Inner Canthus Max C"), ("periorbital_mean_c", "Periorbital Mean C"),
            ("nose_forehead_delta_c", "Nose - Forehead C"), ("canthus_asymmetry_c", "Canthus R-L C"),
            ("cheek_asymmetry_c", "Cheek R-L C"), ("elevated_temp", "Elevated Temp"), ("quality", "Quality"),
        ]
        sheet.append(
            ["Created At (UTC)", "Capture ID", "Subject ID", "Name", "Age", "Gender", "Diet", "Page", "Mode",
             "Duration s", "Source", "Device", "RGB Camera", "RGB Device", "Sync Offset ms (video)",
             "Sync Skew ms (photo)", "Emotion", "Confidence", "Valence", "Arousal", "Has Temperature",
             "Frame Min C", "Frame Max C", "Occluded Landmarks"]
            + [label for _, label in derived_cols]
            + [f"{label} mean C" for label in region_labels]
            + [f"{label} slope C/min" for label in region_labels]
            + ["Face Box", "RGB File", "Thermal File", "Temp Map File", "Overlay File", "Thermal Preview",
               "Thermal Message"]
        )
        frames_sheet = wb.create_sheet("Video thermal frames")
        frames_sheet.append(["Capture ID", "Name", "t (s, thermal)", "t (s, RGB clock)", "Occluded",
                             "Frame Min C", "Frame Max C"] + [f"{label} mean C" for label in region_labels]
                            + [label for _, label in derived_cols[:5]])
        emo_sheet = wb.create_sheet("Video emotion frames")
        emo_sheet.append(["Capture ID", "Name", "t (s)", "Emotion", "Confidence", "Valence", "Arousal"])
        for raw in _rows("DESC"):
            row = _parsed_row(raw)
            frame = row["frame_temp"] or {}
            regions = row["regions"] or {}
            box = row["face_box"] or {}
            der = row["derived"]
            sheet.append(
                [row["created_at"], row["capture_id"], row["subject_id"], row["name"], row["age"], row["gender"],
                 row["diet"], row["page"], row["capture_mode"], row["duration_sec"], row["source"], row["device"],
                 "Phone" if row["rgb_source"] == "mobile" else "Laptop", row.get("rgb_device"),
                 row.get("sync_offset_ms"), row.get("sync_skew_ms"), row["emotion"], row["confidence"], row["valence"], row["arousal"], bool(row["has_temperature"]),
                 frame.get("min"), frame.get("max"), row["occluded_count"]]
                + [der.get(k) for k, _ in derived_cols]
                + [(regions.get(k) or {}).get("mean_c") for k in EXPORT_REGIONS]
                + [(regions.get(k) or {}).get("slope_c_per_min") for k in EXPORT_REGIONS]
                + [",".join(str(box.get(k)) for k in ("x0", "y0", "x1", "y1")) if box else None,
                   raw["rgb_media_path"], raw["thermal_media_path"], raw["temp_map_path"], raw["overlay_path"],
                   raw.get("thermal_preview_path"), row["thermal_message"]]
            )
            for f in row.get("thermal_frames") or []:
                fr = f.get("regions") or {}
                fd = f.get("derived") or {}
                ft = f.get("frame_temp_c") or {}
                frames_sheet.append([row["capture_id"], row["name"], f.get("t"), f.get("t_sync"),
                                     f.get("occluded_count"), ft.get("min"), ft.get("max")]
                                    + [(fr.get(k) or {}).get("mean_c") for k in EXPORT_REGIONS]
                                    + [fd.get(k) for k, _ in derived_cols[:5]])
            for f in row.get("emotion_frames") or []:
                emo_sheet.append([row["capture_id"], row["name"], f.get("timestamp"), f.get("emotion"),
                                  f.get("confidence"), f.get("valence"), f.get("arousal")])
        for ws in (sheet, frames_sheet, emo_sheet):
            for cells in ws.columns:
                width = max((len(str(c.value)) for c in cells if c.value is not None), default=10)
                ws.column_dimensions[cells[0].column_letter].width = min(width + 2, 48)
        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)
        fname = f"thermal_captures_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.xlsx"
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @admin.get("/admin/thermal/frames/{capture_id}")
    def thermal_frames(capture_id: str) -> Dict[str, Any]:
        """Landmarks of every analysed frame of a video capture, with a URL for each frame's image."""
        row = _video_row(capture_id)
        data = _frame_landmarks_for(row)
        return {
            "capture_id": capture_id,
            "range_c": data["range_c"],
            "frames": [{"t": e["t"], "t_sync": e["t_sync"],
                        "occluded_count": sum(1 for p in e["pts"] if p[2] >= thermal_infer.OCCLUSION_THRESHOLD),
                        "landmarks": _expand_landmarks(e),
                        "image_url": f"/admin/thermal/frame/{capture_id}/{k}.jpg"}
                       for k, e in enumerate(data["frames"])],
        }

    @admin.get("/admin/thermal/frame/{capture_id}/{k}.jpg")
    def thermal_frame_image(capture_id: str, k: int) -> Response:
        row = _video_row(capture_id)
        temp, t = _stored_clip(row)
        data = _frame_landmarks_for(row, temp, t)
        if not 0 <= k < len(data["frames"]):
            raise HTTPException(status_code=404, detail="Frame not found.")
        entry = data["frames"][k]
        return Response(_jpeg(_render_frame(temp[entry["i"]], entry, data["range_c"])), media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=86400"})

    @admin.get("/admin/thermal/landmark_video/{capture_id}")
    def thermal_landmark_video(capture_id: str) -> FileResponse:
        """Landmark video of a capture; made (about 0.2 s per thermal frame) and saved on first request."""
        row = _video_row(capture_id)
        stored = row.get("landmark_video_path")
        if stored and os.path.isfile(os.path.join(_deps.backend_dir, stored)):
            return FileResponse(os.path.join(_deps.backend_dir, stored), media_type="video/webm")
        temp, t = _stored_clip(row)
        range_c = _frame_landmarks_for(row, temp, t)["range_c"]
        offset_s = float(row.get("sync_offset_ms") or 0.0) / 1000.0
        every = [_compact_landmarks(res, i, t, offset_s) for i, res in enumerate(thermal_infer.analyze_many(list(temp)))]
        webm = _landmark_video_webm(temp, t, every, range_c)
        if not webm:
            raise HTTPException(status_code=500, detail="The landmark video could not be encoded.")
        path = _store_bytes(webm, row["subject_id"], capture_id, "landmarks", ".webm")
        _update_row(capture_id, landmark_video_path=path)
        return FileResponse(os.path.join(_deps.backend_dir, path), media_type="video/webm")

    return admin


def register(app: FastAPI, deps: CoreDeps) -> None:
    """Attach the thermal routes to the app. Call before the static files mount."""
    global _deps
    _deps = deps
    _init_table(deps.db_path)
    remote_api.register(app, os.path.dirname(deps.db_path))
    app.include_router(router)
    app.include_router(_build_admin_routes(deps.require_admin))

    def _warm_model() -> None:
        try:
            thermal_infer.get_model()
            logger.info("M3MSTL thermal model loaded")
        except Exception:  # the endpoint reports load errors per request
            logger.exception("M3MSTL thermal model failed to preload")

    # Load the ~6 s model in the background so the first capture is not slow.
    app.add_event_handler("startup", lambda: threading.Thread(target=_warm_model, daemon=True).start())
