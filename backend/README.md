# Emotion recognition backend

This service exposes a small FastAPI API that accepts an image or video upload and returns the predicted
emotion, confidence, valence, and arousal using EmotiEffLib's `enet_b0_8_va_mtl` multitask checkpoint.

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## S3 storage & Excel export

Each `/predict` call uploads the captured image/video to S3 and records the emotion result in a
local SQLite file (`backend/data/records.db`). Configure these environment variables before
starting the server:

- `S3_BUCKET_NAME` (required to enable uploads; uploads are skipped with a warning if unset)
- `AWS_REGION` (or `AWS_DEFAULT_REGION`)
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or an attached IAM role / instance profile)
- `S3_CAPTURE_PREFIX` (optional, defaults to `captures`)

Download all recorded results as an Excel workbook (admin login required; also linked from the
dashboard):

```bash
curl -u admin:$ADMIN_PASSWORD -o emotion_captures.xlsx http://127.0.0.1:8000/admin/export
```

## Admin dashboard

`GET /admin/` serves the research dashboard (files in `admin/`), and `GET /admin/data` returns every
subject and capture as JSON, with per-frame results parsed and a `media_url` for each capture.
`GET /admin/media/<subject_id>/<file>` serves stored photos/videos and `GET /admin/export` the Excel
workbook. All of them use HTTP Basic auth (the old `/media/...` and `/export` URLs redirect here):

- `ADMIN_PASSWORD` (required; `/admin/` returns 503 until it is set)
- `ADMIN_USERNAME` (optional, defaults to `admin`)

```bash
curl -u admin:$ADMIN_PASSWORD http://127.0.0.1:8000/admin/data
```

## Run

```bash
ADMIN_PASSWORD='choose-one' uvicorn emotion_api:app --host 127.0.0.1 --port 8000
```

## Test

```bash
curl http://127.0.0.1:8000/health

curl -X POST http://127.0.0.1:8000/predict \
  -F "file=@/path/to/face.jpg" \
  -F "name=Test Subject" -F "age=30" -F "diet=Veg"
```

`name`, `age` (1–120) and `diet` (`Veg` or `Non-Veg`) are required; `subject_id` is optional and is
generated if missing. Uploads with a video extension (`.mp4`, `.webm`, `.mov`, …) are analyzed as a
5-second clip and the response also contains per-frame results in `frames`.

### Blind collection

`POST /collect/submit` takes the same fields as `/predict` but returns `202` with only
`{status, subject_id, capture_id}`. The media and a `pending` capture row are stored before the
response is sent. A single background worker then runs the same analysis and updates the row to
`done` (or `failed`), uploading to S3 if configured. Pending rows are re-queued on startup. The
`/collect/` page (`static/collect/`) uses this endpoint.

```bash
curl -X POST http://127.0.0.1:8000/collect/submit \
  -F "file=@/path/to/face.jpg" \
  -F "name=Test Subject" -F "age=30" -F "diet=Veg"
```

The web frontend in `static/` is served at `/` by the same app, so no separate frontend build or
CORS setup is needed.

## Subject capture storage

Before capturing, the frontend collects the subject's name, age, and diet. It generates a unique
subject ID and sends these fields with every image/video upload. Original media is stored locally at
`backend/data/media/<subject_id>/<capture_id>.<ext>`, while metadata and predictions are stored in
`backend/data/records.db`. See [SUBJECT_DATA_STORAGE.md](SUBJECT_DATA_STORAGE.md) for the schema and
file layout.
