"""Smoke tests for the synced-capture video path: clip loading, sampling, aggregation, derived metrics."""
from __future__ import annotations

import os
import sys
from io import BytesIO

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import thermal_api as ta  # noqa: E402
from test_thermal_infer import _synthetic_face  # noqa: E402


def _clip_bytes(n=21, fps=10.0, drift_c_per_s=0.05):
    base = _synthetic_face()
    frames = np.stack([base + drift_c_per_s * (i / fps) for i in range(n)])
    centi = np.round(frames * 100).astype(np.int16)  # same encoding as thermal-agent /record.npz
    buf = BytesIO()
    np.savez_compressed(buf, frames=centi, t=np.arange(n, dtype=np.float32) / fps, scale=np.float32(0.01))
    return buf.getvalue()


def test_load_clip_and_sampling():
    temp, t = ta._load_thermal_clip(_clip_bytes())
    assert temp.shape == (21, 192, 256) and temp.dtype == np.float32
    assert abs(float(t[-1]) - 2.0) < 1e-6
    idx = ta._sample_indices(t)
    assert idx == [0, 5, 10, 15, 20]


def test_run_thermal_video():
    res = ta._run_thermal_video(_clip_bytes(), offset_ms=100)
    assert res["clip"]["frames"] == 21 and res["clip"]["sampled"] == 5
    assert res["frames"][1]["t"] == 0.5 and res["frames"][1]["t_sync"] == 0.4
    face = res["regions"]["face"]
    assert face["samples"] == 5 and face["mean_c"] is not None
    # 0.05 C/s drift -> about +3 C/min on every region with readings
    assert 2.0 < face["slope_c_per_min"] < 4.0
    assert res["_overlay_png"][:4] == b"\x89PNG"
    assert len(res["landmarks"]) == 68
    # One landmark image per analysed frame, on one colour scale; a landmark video of every frame.
    fl = res["_frame_landmarks"]
    assert [e["t"] for e in fl["frames"]] == [f["t"] for f in res["frames"]]
    assert all(len(e["pts"]) == 68 and len(e["box"]) == 4 for e in fl["frames"])
    assert fl["range_c"][0] < fl["range_c"][1]
    assert len(res["_frame_images"]) == 5 and all(j[:2] == b"\xff\xd8" for j in res["_frame_images"])
    assert res["_landmark_webm"][:4] == b"\x1a\x45\xdf\xa3"  # EBML / WebM


def test_analyze_many_matches_analyze():
    temp, _ = ta._load_thermal_clip(_clip_bytes(n=3))
    many = ta.thermal_infer.analyze_many(list(temp), batch_size=2)
    for frame, res in zip(temp, many):
        one = ta.thermal_infer.analyze(temp_c=frame, want_overlay=False)
        assert one["face_box"] == res["face_box"] and one["occluded_count"] == res["occluded_count"]
        assert max(abs(a["x"] - b["x"]) + abs(a["y"] - b["y"]) for a, b in zip(one["landmarks"], res["landmarks"])) < 0.05


def _app(tmp):
    from fastapi import FastAPI

    media = os.path.join(tmp, "data", "media")
    os.makedirs(media)
    deps = ta.CoreDeps(
        db_path=os.path.join(tmp, "data", "records.db"), media_dir=media, backend_dir=tmp,
        validate_submission=lambda f, name, age, diet: (name, diet), validate_gender=lambda g: g,
        subject_id=lambda s: s or "sub_test", register_subject=lambda *a, **k: None,
        safe_component=lambda v, d: v, media_url=lambda p: f"/admin/media/{p}" if p else None,
        analyze_image=lambda p: {}, require_admin=lambda: None, analyze_video=None,
    )
    app = FastAPI()
    ta._deps = deps
    ta._init_table(deps.db_path)
    app.include_router(ta.router)
    app.include_router(ta._build_admin_routes(deps.require_admin))
    return app, deps


def test_predict_video_and_admin_frames(tmp_path):
    import sqlite3

    from fastapi.testclient import TestClient

    app, deps = _app(str(tmp_path))
    client = TestClient(app)
    r = client.post("/thermal/predict_video", files={"thermal_clip": ("clip.npz", _clip_bytes(), "application/octet-stream")},
                    data={"name": "T", "age": "30", "diet": "Veg", "duration": "5"})
    assert r.status_code == 200, r.text
    th = r.json()["thermal"]
    assert th["landmark_video"].startswith("data:video/webm;base64,")
    assert all(f["image"].startswith("data:image/jpeg;base64,") and len(f["landmarks"]) == 68 for f in th["frames"])
    cid = r.json()["capture_id"]

    # Images and landmarks are not stored in the per-frame readings; the dashboard list stays lean.
    data = client.get("/admin/thermal/data").json()["captures"][0]
    assert "frame_landmarks_json" not in data and "image" not in data["thermal_frames"][0]
    assert data["landmark_video_url"]

    frames = client.get(f"/admin/thermal/frames/{cid}").json()["frames"]
    assert len(frames) == 5 and len(frames[2]["landmarks"]) == 68
    img = client.get(frames[2]["image_url"])
    assert img.status_code == 200 and img.content[:2] == b"\xff\xd8"
    assert client.get(f"/admin/thermal/frame/{cid}/99.jpg").status_code == 404
    assert client.get(f"/admin/thermal/landmark_video/{cid}").content[:4] == b"\x1a\x45\xdf\xa3"

    # Captures made before per-frame landmarks existed are analysed on first request and saved.
    conn = sqlite3.connect(deps.db_path)
    conn.execute("UPDATE thermal_captures SET frame_landmarks_json = NULL, landmark_video_path = NULL")
    conn.commit()
    conn.close()
    assert [f["t"] for f in client.get(f"/admin/thermal/frames/{cid}").json()["frames"]] == [f["t"] for f in frames]
    assert client.get(f"/admin/thermal/landmark_video/{cid}").content[:4] == b"\x1a\x45\xdf\xa3"
    conn = sqlite3.connect(deps.db_path)
    stored = conn.execute("SELECT frame_landmarks_json IS NOT NULL, landmark_video_path FROM thermal_captures").fetchone()
    conn.close()
    assert stored[0] == 1 and stored[1].endswith("_landmarks.webm")
    assert client.get("/admin/thermal/frames/thv_missing").status_code == 404


def test_derived_metrics():
    regions = {
        "right_inner_canthus": {"mean_c": 36.9, "max_c": 37.6}, "left_inner_canthus": {"mean_c": 36.5, "max_c": 36.8},
        "nose_tip": {"mean_c": 32.0}, "forehead": {"mean_c": 34.5}, "face": {"mean_c": 34.0, "max_c": 37.6},
    }
    d = ta.derived_metrics(regions, 5, "auto_skin_temperature", True)
    assert d["canthus_max_c"] == 37.6 and d["elevated_temp"] is True
    assert d["canthus_asymmetry_c"] == 0.4 and d["nose_forehead_delta_c"] == -2.5
    assert d["quality"] == "good"
    assert ta.derived_metrics(regions, 40, "auto_skin_temperature", True)["quality"] == "poor"
    assert ta.derived_metrics(None, 0, "provided", False)["quality"] == "no_temperature"
