const $ = (id) => document.getElementById(id);

const subjectForm = $('subjectForm');
const subjectName = $('subjectName');
const subjectAge = $('subjectAge');
const subjectSubmitBtn = $('subjectSubmitBtn');
const subjectCancelBtn = $('subjectCancelBtn');
const subjectSummary = $('subjectSummary');
const editSubjectBtn = $('editSubjectBtn');
const newSubjectBtn = $('newSubjectBtn');

const stage = $('stage');
const video = $('preview');
const stageEmpty = $('stageEmpty');
const stageEmptyText = $('stageEmptyText');
const startBtn = $('startBtn');
const cameraSelect = $('cameraSelect');
const recBadge = $('recBadge');
const timerEl = $('timer');
const recProgress = $('recProgress');
const stageBusy = $('stageBusy');
const shutterBtn = $('shutterBtn');
const shutterLabel = $('shutterLabel');
const captureTip = $('captureTip');
const statusEl = $('status');
const snapshotCanvas = $('snapshotCanvas');

const resultDialog = $('resultDialog');
const historySection = $('historySection');
const historyList = $('historyList');

const RECORD_SECONDS = 5;
const SUBJECT_STORAGE_KEY = 'emotionCapture.subject';

const EMOTIONS = {
  Happiness: { emoji: '😊', color: '#e2a400' },
  Neutral: { emoji: '😐', color: '#7a8699' },
  Sadness: { emoji: '😢', color: '#3b82f6' },
  Anger: { emoji: '😠', color: '#e5484d' },
  Fear: { emoji: '😨', color: '#8e5cd9' },
  Surprise: { emoji: '😲', color: '#e0559b' },
  Disgust: { emoji: '🤢', color: '#3f9b4e' },
  Contempt: { emoji: '😒', color: '#c46a2b' },
  Unknown: { emoji: '', color: '#7a8699' },
};

const state = {
  subject: null,
  editing: false,
  stream: null,
  mode: 'photo',
  recording: false,
  busy: false,
  recorder: null,
  recordTimers: [],
  history: [],
};

// ---------- Helpers ----------

function emotionInfo(name) {
  return EMOTIONS[name] || EMOTIONS.Unknown;
}

function formatPercent(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

function formatSigned(value) {
  const n = Number(value);
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.hidden = !text;
  statusEl.classList.toggle('is-error', Boolean(isError));
}

function loadStoredSubject() {
  try {
    const raw = sessionStorage.getItem(SUBJECT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeSubject(subject) {
  try {
    if (subject) sessionStorage.setItem(SUBJECT_STORAGE_KEY, JSON.stringify(subject));
    else sessionStorage.removeItem(SUBJECT_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode etc.) — the subject just won't survive a reload.
  }
}

function newSubjectId() {
  const generatedId = window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32);
  return `sub_${generatedId.replaceAll('-', '')}`;
}

// ---------- UI state ----------

function render() {
  const hasSubject = Boolean(state.subject);
  const showForm = !hasSubject || state.editing;
  const locked = state.busy || state.recording;

  // Participant panel
  subjectForm.hidden = !showForm;
  subjectSummary.hidden = showForm;
  subjectCancelBtn.hidden = !(hasSubject && state.editing);
  subjectSubmitBtn.textContent = hasSubject && state.editing ? 'Save changes' : 'Save & continue';
  editSubjectBtn.disabled = locked;
  newSubjectBtn.disabled = locked;
  if (hasSubject) {
    $('subjectAvatar').textContent = state.subject.name.charAt(0).toUpperCase();
    $('summaryName').textContent = state.subject.name;
    $('summaryDetails').textContent = `Age ${state.subject.age} · ${state.subject.gender} · ${state.subject.diet}`;
    $('summaryId').textContent = state.subject.subject_id;
  }

  // Camera stage
  const live = Boolean(state.stream);
  stage.classList.toggle('is-live', live);
  stage.classList.toggle('is-recording', state.recording);
  stageEmpty.hidden = live;
  if (!window.isSecureContext) {
    stageEmptyText.textContent = 'The camera only works over a secure https:// connection.';
    startBtn.disabled = true;
  } else if (!hasSubject) {
    stageEmptyText.textContent = 'Add participant details to get started.';
    startBtn.disabled = true;
  } else if (!stageEmptyText.dataset.error) {
    stageEmptyText.textContent = `Ready to capture ${state.subject.name}.`;
    startBtn.disabled = false;
  } else {
    startBtn.disabled = false;
  }
  cameraSelect.disabled = locked;
  stageBusy.hidden = !state.busy;

  // Capture controls
  const canCapture = live && hasSubject && !state.editing && !state.busy;
  shutterBtn.disabled = !canCapture && !state.recording;
  shutterBtn.classList.toggle('is-video', state.mode === 'video');
  shutterBtn.classList.toggle('is-recording', state.recording);
  document.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.disabled = locked;
  });
  if (state.recording) {
    shutterLabel.textContent = 'Stop early';
  } else {
    shutterLabel.textContent = state.mode === 'video' ? `Record ${RECORD_SECONDS} s` : 'Take photo';
  }

  if (!hasSubject || state.editing) {
    captureTip.textContent = 'Save participant details to enable capture.';
  } else if (!live) {
    captureTip.textContent = 'Turn on the camera to begin.';
  } else if (state.recording) {
    captureTip.textContent = 'Hold still and keep your face inside the oval.';
  } else if (state.mode === 'video') {
    captureTip.textContent = 'Video gives a more reliable result by averaging several frames.';
  } else {
    captureTip.textContent = 'Face the camera in good light, with one face in the oval.';
  }

  // Stepper
  const resultsOpen = resultDialog.open;
  const current = resultsOpen ? 3 : hasSubject && !state.editing ? 2 : 1;
  [1, 2, 3].forEach((n) => {
    const step = $(`step${n}`);
    step.classList.toggle('is-active', n === current);
    step.classList.toggle('is-done', n < current);
    if (n === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });

  // History
  historySection.hidden = state.history.length === 0;
}

// ---------- Participant form ----------

function setFieldError(key, message) {
  const errorEl = subjectForm.querySelector(`.field-error[data-for="${key}"]`);
  errorEl.textContent = message || '';
  errorEl.closest('.field').classList.toggle('has-error', Boolean(message));
}

function validateSubjectForm() {
  const name = subjectName.value.trim();
  const age = Number(subjectAge.value);
  const gender = subjectForm.querySelector('input[name="gender"]:checked');
  const diet = subjectForm.querySelector('input[name="diet"]:checked');
  setFieldError('subjectName', name ? '' : 'Please enter a name.');
  setFieldError(
    'subjectAge',
    subjectAge.value && Number.isInteger(age) && age >= 1 && age <= 120 ? '' : 'Enter an age between 1 and 120.',
  );
  setFieldError('gender', gender ? '' : 'Choose one.');
  setFieldError('diet', diet ? '' : 'Choose one.');
  const firstInvalid = subjectForm.querySelector('.has-error input');
  if (firstInvalid) {
    firstInvalid.focus();
    return null;
  }
  return { name, age: String(age), gender: gender.value, diet: diet.value };
}

function fillSubjectForm(subject) {
  subjectName.value = subject ? subject.name : '';
  subjectAge.value = subject ? subject.age : '';
  subjectForm.querySelectorAll('input[name="gender"]').forEach((input) => {
    input.checked = Boolean(subject) && input.value === subject.gender;
  });
  subjectForm.querySelectorAll('input[name="diet"]').forEach((input) => {
    input.checked = Boolean(subject) && input.value === subject.diet;
  });
  ['subjectName', 'subjectAge', 'gender', 'diet'].forEach((key) => setFieldError(key, ''));
}

subjectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = validateSubjectForm();
  if (!values) return;
  // Editing keeps the same ID so later captures stay linked to this person.
  const subjectId = state.subject && state.editing ? state.subject.subject_id : newSubjectId();
  state.subject = { subject_id: subjectId, ...values };
  state.editing = false;
  storeSubject(state.subject);
  setStatus('');
  render();
  if (!state.stream && window.matchMedia('(max-width: 859px)').matches) {
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

subjectForm.addEventListener('input', (event) => {
  const key = ['diet', 'gender'].includes(event.target.name) ? event.target.name : event.target.id;
  if (key) setFieldError(key, '');
});

subjectCancelBtn.addEventListener('click', () => {
  state.editing = false;
  render();
});

editSubjectBtn.addEventListener('click', () => {
  fillSubjectForm(state.subject);
  state.editing = true;
  render();
  subjectName.focus();
});

function startNewParticipant() {
  state.subject = null;
  state.editing = false;
  storeSubject(null);
  fillSubjectForm(null);
  render();
  subjectName.focus();
}

newSubjectBtn.addEventListener('click', startNewParticipant);

// ---------- Camera ----------

function describeCameraError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera in your browser’s site settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is being used by another app. Close it and try again.';
    default:
      return `Could not start the camera${err && err.message ? `: ${err.message}` : '.'}`;
  }
}

async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const activeId = state.stream && state.stream.getVideoTracks()[0]?.getSettings().deviceId;
  cameraSelect.innerHTML = '';
  cameras.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
    if (cam.deviceId === activeId) opt.selected = true;
    cameraSelect.appendChild(opt);
  });
  cameraSelect.hidden = cameras.length < 2;
}

async function startCamera(deviceId) {
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' },
  });
  state.stream = stream;
  video.srcObject = stream;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Waiting for permission…';
  try {
    await startCamera();
    await listCameras();
    delete stageEmptyText.dataset.error;
    setStatus('');
  } catch (err) {
    stageEmptyText.dataset.error = '1';
    stageEmptyText.textContent = describeCameraError(err);
  } finally {
    startBtn.textContent = 'Turn on camera';
    render();
  }
});

cameraSelect.addEventListener('change', async () => {
  try {
    await startCamera(cameraSelect.value);
  } catch (err) {
    setStatus(describeCameraError(err), true);
  }
  render();
});

// ---------- Capture ----------

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    state.mode = input.value;
    render();
  });
});

shutterBtn.addEventListener('click', () => {
  if (state.recording) {
    stopRecording();
  } else if (state.mode === 'video') {
    startRecording();
  } else {
    takePhoto();
  }
});

function captureFrameDataUrl() {
  snapshotCanvas.width = video.videoWidth || 640;
  snapshotCanvas.height = video.videoHeight || 480;
  snapshotCanvas.getContext('2d').drawImage(video, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
  return snapshotCanvas.toDataURL('image/jpeg', 0.92);
}

function takePhoto() {
  const previewDataUrl = captureFrameDataUrl();
  state.busy = true;
  render();
  snapshotCanvas.toBlob(
    (blob) => submitMedia(blob, 'jpg', previewDataUrl, 'photo'),
    'image/jpeg',
    0.92,
  );
}

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
}

function startRecording() {
  if (!window.MediaRecorder) {
    setStatus('This browser cannot record video. Switch to Photo mode instead.', true);
    return;
  }
  const mimeType = pickMimeType();
  const chunks = [];
  const recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.recorder = recorder;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    clearRecordingUi();
    const previewDataUrl = captureFrameDataUrl();
    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    state.busy = true;
    render();
    submitMedia(blob, extension, previewDataUrl, 'video');
  };

  setStatus('');
  state.recording = true;
  recorder.start();

  const startedAt = performance.now();
  timerEl.textContent = RECORD_SECONDS;
  recBadge.hidden = false;
  recProgress.hidden = false;
  recProgress.style.setProperty('--rec-duration', `${RECORD_SECONDS}s`);
  recProgress.classList.remove('is-running');
  void recProgress.offsetWidth; // restart the CSS animation
  recProgress.classList.add('is-running');

  state.recordTimers.push(
    setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      timerEl.textContent = Math.max(0, Math.ceil(RECORD_SECONDS - elapsed));
    }, 200),
    setTimeout(stopRecording, RECORD_SECONDS * 1000),
  );
  render();
}

function stopRecording() {
  if (state.recorder && state.recorder.state === 'recording') state.recorder.stop();
}

function clearRecordingUi() {
  state.recordTimers.forEach((id) => {
    clearInterval(id);
    clearTimeout(id);
  });
  state.recordTimers = [];
  state.recording = false;
  state.recorder = null;
  recBadge.hidden = true;
  recProgress.hidden = true;
  recProgress.classList.remove('is-running');
}

async function readErrorDetail(response) {
  try {
    const body = await response.json();
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join('; ');
  } catch {
    // Not JSON — fall through to the status text.
  }
  return `The server responded with ${response.status} ${response.statusText}`.trim();
}

async function submitMedia(blob, extension, previewDataUrl, kind) {
  const subject = state.subject;
  const formData = new FormData();
  formData.append('file', blob, `capture.${extension}`);
  formData.append('subject_id', subject.subject_id);
  formData.append('name', subject.name);
  formData.append('age', subject.age);
  formData.append('gender', subject.gender);
  formData.append('diet', subject.diet);

  try {
    const response = await fetch('/predict', { method: 'POST', body: formData });
    if (!response.ok) throw new Error(await readErrorDetail(response));
    const data = await response.json();
    const entry = { data, preview: previewDataUrl, kind, at: new Date() };
    state.history.unshift(entry);
    renderHistory();
    state.busy = false;
    openResult(entry);
  } catch (err) {
    state.busy = false;
    const offline = err instanceof TypeError;
    setStatus(
      offline
        ? 'Could not reach the server. Check your connection and try again.'
        : `Analysis failed: ${err.message}`,
      true,
    );
  }
  render();
}

// ---------- Results ----------

function describeMood(valence, arousal) {
  const v = valence > 0.15 ? 'pleasant' : valence < -0.15 ? 'unpleasant' : 'neutral';
  const a = arousal > 0.15 ? 'energized' : arousal < -0.15 ? 'calm' : 'steady';
  if (v === 'neutral' && a === 'steady') return 'Neutral and steady';
  return `${v.charAt(0).toUpperCase()}${v.slice(1)} and ${a}`;
}

function confidenceNote(confidence) {
  if (confidence >= 0.6) return 'Strong signal — the model is fairly sure.';
  if (confidence >= 0.35) return 'Moderate signal — other emotions were also likely.';
  return 'Weak signal — treat this result with caution.';
}

function moodPoint(valence, arousal) {
  return {
    x: 100 + clamp(Number(valence), -1, 1) * 80,
    y: 100 - clamp(Number(arousal), -1, 1) * 80,
  };
}

function openResult(entry) {
  const { data, preview, kind } = entry;
  const emotion = data.emotion || 'Unknown';
  const info = emotionInfo(emotion);
  const hasResult = emotion !== 'Unknown';
  const hasAffect = data.valence != null && data.arousal != null;

  resultDialog.style.setProperty('--emotion', info.color);
  $('resultImage').src = preview;
  $('resultKind').textContent = kind === 'video' ? 'Video result · 5 seconds' : 'Photo result';
  $('resultEmoji').textContent = info.emoji;
  $('resultEmotionText').textContent = hasResult ? emotion : 'No result';

  $('confidenceBlock').hidden = !hasResult;
  if (hasResult) {
    $('confidenceValue').textContent = formatPercent(data.confidence);
    $('confidenceBar').style.width = '0';
    requestAnimationFrame(() => {
      $('confidenceBar').style.width = formatPercent(data.confidence);
    });
    $('confidenceNote').textContent = confidenceNote(Number(data.confidence));
  }

  $('resultParticipant').textContent = data.name
    ? `${data.name} · ${entry.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';

  $('noFaceBlock').hidden = hasResult;
  if (!hasResult) {
    $('noFaceTitle').textContent = data.fallback ? 'The analysis could not finish' : 'No face found';
    $('noFaceMessage').textContent = data.message || '';
  }

  $('moodBlock').hidden = !(hasResult && hasAffect);
  if (hasResult && hasAffect) {
    const point = moodPoint(data.valence, data.arousal);
    const dot = $('moodDot');
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    const trail = $('moodTrail');
    trail.innerHTML = '';
    (data.frames || []).forEach((frame) => {
      if (frame.valence == null || frame.arousal == null) return;
      const p = moodPoint(frame.valence, frame.arousal);
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', 3.5);
      c.setAttribute('class', 'mood-trail-dot');
      trail.appendChild(c);
    });
    $('moodSummary').textContent = describeMood(Number(data.valence), Number(data.arousal));
    $('valenceValue').textContent = formatSigned(data.valence);
    $('arousalValue').textContent = formatSigned(data.arousal);
  }

  const frames = Array.isArray(data.frames) ? data.frames : [];
  $('framesBlock').hidden = frames.length === 0;
  const framesList = $('framesList');
  framesList.innerHTML = '';
  frames.forEach((frame) => {
    const frameInfo = emotionInfo(frame.emotion);
    const li = document.createElement('li');
    li.className = 'frame';
    li.style.setProperty('--frame-color', frameInfo.color);
    const img = document.createElement('img');
    img.src = frame.image;
    img.alt = `Face at ${frame.timestamp}s`;
    const time = document.createElement('span');
    time.className = 'f-time';
    time.textContent = `${Number(frame.timestamp).toFixed(1)}s`;
    const label = document.createElement('span');
    label.className = 'f-emotion';
    label.textContent = `${frameInfo.emoji} ${frame.emotion}`.trim();
    const conf = document.createElement('span');
    conf.className = 'f-time';
    conf.textContent = frame.confidence != null ? formatPercent(frame.confidence) : '';
    li.append(img, time, label, conf);
    framesList.appendChild(li);
  });

  $('logicBlock').hidden = !data.logic;
  $('logicBlock').open = false;
  $('logicText').textContent = data.logic || '';

  const mediaLink = $('mediaLink');
  mediaLink.hidden = !data.media_url;
  if (data.media_url) {
    mediaLink.href = data.media_url;
    mediaLink.textContent = kind === 'video' ? 'Open saved recording ↗' : 'Open saved photo ↗';
    mediaLink.title = 'Requires the admin login';
  }

  if (!resultDialog.open) resultDialog.showModal();
  resultDialog.querySelector('.result-body').scrollTop = 0;
  render();
}

function closeResult() {
  if (resultDialog.open) resultDialog.close();
}

$('closeDialogBtn').addEventListener('click', closeResult);
$('captureAgainBtn').addEventListener('click', closeResult);
$('newParticipantFromResultBtn').addEventListener('click', () => {
  closeResult();
  startNewParticipant();
});
resultDialog.addEventListener('close', () => {
  render();
  if (!shutterBtn.disabled) shutterBtn.focus();
});
// Clicking the dimmed backdrop closes the dialog.
resultDialog.addEventListener('click', (event) => {
  if (event.target === resultDialog) closeResult();
});

// ---------- Session history ----------

function renderHistory() {
  historyList.innerHTML = '';
  state.history.forEach((entry) => {
    const { data } = entry;
    const info = emotionInfo(data.emotion);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    const img = document.createElement('img');
    img.src = entry.preview;
    img.alt = '';
    const main = document.createElement('div');
    main.className = 'h-main';
    const emotionEl = document.createElement('div');
    emotionEl.className = 'h-emotion';
    emotionEl.textContent = data.emotion === 'Unknown' ? 'No result' : `${info.emoji} ${data.emotion}`;
    const sub = document.createElement('div');
    sub.className = 'h-sub';
    const time = entry.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    sub.textContent = `${data.name || ''} · ${entry.kind === 'video' ? 'Video' : 'Photo'} · ${time}`;
    main.append(emotionEl, sub);
    const conf = document.createElement('span');
    conf.className = 'h-conf';
    conf.textContent = data.emotion !== 'Unknown' && data.confidence != null ? formatPercent(data.confidence) : '';
    btn.append(img, main, conf);
    btn.addEventListener('click', () => openResult(entry));
    li.appendChild(btn);
    historyList.appendChild(li);
  });
}

// ---------- Init ----------

state.subject = loadStoredSubject();
render();
if (!state.subject) subjectName.focus();
