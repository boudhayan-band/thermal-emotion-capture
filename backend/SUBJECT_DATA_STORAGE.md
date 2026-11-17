# Subject and capture storage

The frontend requires these fields before camera capture:

- `name`
- `age`
- `diet`: `Veg` or `Non-Veg`

Each completed form receives a stable `subject_id` for that capture session. Each image/video
submission receives a separate `capture_id`.

## File structure

```text
backend/
├── emotion_api.py                 # FastAPI routes and persistence
├── infer_emotion_va.py            # EmotiEffLib inference wrapper
├── static/
│   ├── index.html                  # Subject form and capture UI
│   ├── app.js                      # Form, camera, upload, and result display
│   └── style.css
└── data/
    ├── records.db                 # Subject and capture metadata/results
    └── media/
        └── <subject_id>/
            └── <capture_id>.<ext>  # Original image or video
```

## Stored result

Each capture stores the subject details, media type, original filename, capture ID, media path,
emotion, confidence, valence, arousal, and frame-level results. For videos, the frame-level JSON
contains timestamp, emotion, confidence, valence, and arousal; face preview images are not duplicated
inside SQLite.

Two extra columns separate the capture apps. `capture_mode` is `blind` for captures from
`/collect/` and NULL for the interactive app. `analysis_status` is `pending`, `done` or `failed`
for blind captures and NULL for interactive ones, which are analyzed before they are stored. A
blind capture's emotion fields stay empty until its status leaves `pending`.

The `/predict` response includes `media_url` (`/admin/media/...`), which serves the stored file to a
logged-in admin, and `/admin/export` includes the subject and capture fields in the Excel report. S3 upload remains optional; local storage is always
written under `data/media`.
