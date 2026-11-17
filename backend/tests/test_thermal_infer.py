"""Smoke test for thermal_infer on a synthetic temperature map.

Run from backend/:  .venv/bin/python -m pytest -q tests  (or: .venv/bin/python tests/test_thermal_infer.py)
Needs the model at models/m3mstl/resnet_vit_stage3_final.h5.
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import thermal_infer as ti  # noqa: E402


def _synthetic_face(h=192, w=256):
    t = np.full((h, w), 22.0, np.float32)
    cv2.ellipse(t, (128, 92), (52, 68), 0, 0, 360, 34.0, -1)
    cv2.circle(t, (116, 80), 2, 36.6, -1)
    cv2.ellipse(t, (128, 104), (8, 12), 0, 0, 360, 31.0, -1)
    return t


def test_analyze_with_temperature_map():
    r = ti.analyze(temp_c=_synthetic_face())
    assert r["face_box"]["source"] == "auto_skin_temperature"
    assert len(r["landmarks"]) == 68
    assert r["has_temperature"] and "regions" in r
    assert 21.0 < r["regions"]["face"]["mean_c"] < 37.0
    assert r.pop("_overlay_png").startswith(b"\x89PNG")
    json.dumps(r)


def test_analyze_image_only_and_explicit_box():
    g = ti.render_gray(_synthetic_face())
    r = ti.analyze(image_gray=g, face_box=(70, 20, 186, 165), want_overlay=False)
    assert r["face_box"]["source"] == "provided"
    assert not r["has_temperature"] and "regions" not in r
    assert all(l["temp_c"] is None for l in r["landmarks"])


def test_load_temperature_map_formats():
    t = _synthetic_face()
    import io
    buf = io.BytesIO(); np.save(buf, t)
    assert ti.load_temperature_map(buf.getvalue(), "x.npy").shape == t.shape
    csv = "\n".join(",".join(f"{v:.2f}" for v in row) for row in t).encode()
    assert ti.load_temperature_map(csv, "x.csv").shape == t.shape


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
