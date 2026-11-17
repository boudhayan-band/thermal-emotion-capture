// Blind data-collection variant of the capture app: the participant never sees the analysis result.
// Captures are queued for upload so the next participant can start immediately; the server stores
// each one and analyzes it in the background.

const $ = (id) => document.getElementById(id);

const subjectForm = $('subjectForm');
const subjectName = $('subjectName');
const subjectRollNo = $('subjectRollNo');
const subjectAge = $('subjectAge');
const subjectSubmitBtn = $('subjectSubmitBtn');
const subjectCancelBtn = $('subjectCancelBtn');
const subjectSummary = $('subjectSummary');
const editSubjectBtn = $('editSubjectBtn');
const clearSubjectBtn = $('clearSubjectBtn');
const uploadStateEl = $('uploadState');

const stage = $('stage');
const video = $('preview');
const stageEmpty = $('stageEmpty');
const stageEmptyText = $('stageEmptyText');
const startBtn = $('startBtn');
const cameraSelect = $('cameraSelect');
const recBadge = $('recBadge');
const timerEl = $('timer');
const recProgress = $('recProgress');
const stageDone = $('stageDone');
const stageDoneText = $('stageDoneText');
const nextParticipantBtn = $('nextParticipantBtn');
const shutterBtn = $('shutterBtn');
const shutterLabel = $('shutterLabel');
const captureTip = $('captureTip');
const statusEl = $('status');
const stimulus = $('stimulus');

const RECORD_SECONDS = 5;
const DONE_SCREEN_MS = 4000;
const UPLOAD_RETRY_MS = 5000;

const state = {
  subject: null,
  editing: false,
  stream: null,
  recording: false,
  busy: false,
  recorder: null,
  recordTimers: [],
  done: false,
  doneTimer: null,
};

// Uploads run one at a time in the background and retry until the server accepts them.
const uploads = {
  queue: [],
  active: false,
  retryTimer: null,
  saved: 0,
  rejected: 0,
  error: '',
};

// ---------- Helpers ----------

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.hidden = !text;
  statusEl.classList.toggle('is-error', Boolean(isError));
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
  const locked = state.recording;

  // Participant panel
  subjectForm.hidden = !showForm;
  subjectSummary.hidden = showForm;
  subjectCancelBtn.hidden = !(hasSubject && state.editing);
  subjectSubmitBtn.textContent = hasSubject && state.editing ? 'Save changes' : 'Save & continue';
  editSubjectBtn.disabled = locked;
  clearSubjectBtn.disabled = locked;
  if (hasSubject) {
    $('subjectAvatar').textContent = state.subject.name.charAt(0).toUpperCase();
    $('summaryName').textContent = state.subject.name;
    $('summaryDetails').textContent = `Roll No ${state.subject.roll_no} · Age ${state.subject.age} · ${state.subject.gender} · ${state.subject.diet}`;
  }

  // Camera stage
  const live = Boolean(state.stream);
  stage.classList.toggle('is-live', live);
  stage.classList.toggle('is-recording', state.recording);
  stimulus.hidden = !state.recording;
  stageEmpty.hidden = live;
  stageDone.hidden = !state.done;
  if (!window.isSecureContext) {
    stageEmptyText.textContent = 'The camera only works over a secure https:// connection.';
    startBtn.disabled = true;
  } else if (!stageEmptyText.dataset.error) {
    // Unlike the results app, the camera can be turned on before any details are entered.
    stageEmptyText.textContent = hasSubject ? `Ready to capture ${state.subject.name}.` : 'Turn on the camera, then add participant details.';
    startBtn.disabled = false;
  } else {
    startBtn.disabled = false;
  }
  cameraSelect.disabled = locked;

  // Capture controls
  const canCapture = live && hasSubject && !state.editing && !state.done && !state.busy;
  shutterBtn.disabled = !canCapture && !state.recording;
  shutterBtn.classList.add('is-video');
  shutterBtn.classList.toggle('is-recording', state.recording);
  if (state.recording) {
    shutterLabel.textContent = 'Stop early';
  } else {
    shutterLabel.textContent = 'Capture';
  }

  if (!hasSubject || state.editing) {
    captureTip.textContent = 'Save participant details to enable capture.';
  } else if (!live) {
    captureTip.textContent = 'Turn on the camera to begin.';
  } else if (state.recording) {
    captureTip.textContent = 'Look at the picture and keep your face towards the camera.';
  } else {
    captureTip.textContent = `Face the camera in good light, with one face in the oval, then press Capture (${RECORD_SECONDS} s).`;
  }

  // Stepper
  const current = state.done ? 3 : hasSubject && !state.editing ? 2 : 1;
  [1, 2, 3].forEach((n) => {
    const step = $(`step${n}`);
    step.classList.toggle('is-active', n === current);
    step.classList.toggle('is-done', n < current);
    if (n === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });

  renderUploadState();
}

function renderUploadState() {
  const pending = uploads.queue.length;
  let text = '';
  if (pending > 0) {
    const what = pending === 1 ? '1 capture' : `${pending} captures`;
    text = uploads.error
      ? `${what} waiting to upload — ${uploads.error}. Retrying automatically; keep this page open.`
      : `Uploading ${what}…`;
  } else if (uploads.saved > 0) {
    text = `${uploads.saved} ${uploads.saved === 1 ? 'capture' : 'captures'} saved this session.`;
  }
  if (uploads.rejected > 0) {
    text += ` ${uploads.rejected} rejected by the server.`;
  }
  uploadStateEl.textContent = text.trim();
  uploadStateEl.hidden = !text;
  uploadStateEl.classList.toggle('is-error', Boolean(uploads.error) || uploads.rejected > 0);
}

// ---------- Participant form ----------

function setFieldError(key, message) {
  const errorEl = subjectForm.querySelector(`.field-error[data-for="${key}"]`);
  errorEl.textContent = message || '';
  errorEl.closest('.field').classList.toggle('has-error', Boolean(message));
}

function validateSubjectForm() {
  const name = subjectName.value.trim();
  const rollNo = subjectRollNo.value.trim();
  const age = Number(subjectAge.value);
  const gender = subjectForm.querySelector('input[name="gender"]:checked');
  const diet = subjectForm.querySelector('input[name="diet"]:checked');
  setFieldError('subjectName', name ? '' : 'Please enter a name.');
  setFieldError('subjectRollNo', rollNo ? '' : 'Please enter a roll number.');
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
  return { name, roll_no: rollNo, age: String(age), gender: gender.value, diet: diet.value };
}

function fillSubjectForm(subject) {
  subjectName.value = subject ? subject.name : '';
  subjectRollNo.value = subject ? subject.roll_no : '';
  subjectAge.value = subject ? subject.age : '';
  subjectForm.querySelectorAll('input[name="gender"]').forEach((input) => {
    input.checked = Boolean(subject) && input.value === subject.gender;
  });
  subjectForm.querySelectorAll('input[name="diet"]').forEach((input) => {
    input.checked = Boolean(subject) && input.value === subject.diet;
  });
  ['subjectName', 'subjectRollNo', 'subjectAge', 'gender', 'diet'].forEach((key) => setFieldError(key, ''));
}

subjectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = validateSubjectForm();
  if (!values) return;
  // Editing keeps the same ID so later captures stay linked to this person.
  const subjectId = state.subject && state.editing ? state.subject.subject_id : newSubjectId();
  state.subject = { subject_id: subjectId, ...values };
  state.editing = false;
  hideDone();
  setStatus('');
  render();
  if (window.matchMedia('(max-width: 859px)').matches) {
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

function resetParticipant() {
  state.subject = null;
  state.editing = false;
  fillSubjectForm(null);
  render();
}

clearSubjectBtn.addEventListener('click', () => {
  resetParticipant();
  subjectName.focus();
});

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

shutterBtn.addEventListener('click', () => {
  if (state.recording) {
    stopRecording();
  } else {
    startRecording();
  }
});

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
}

function startRecording() {
  if (!window.MediaRecorder) {
    setStatus('This browser cannot record video. Please use an up-to-date Chrome, Edge or Safari.', true);
    return;
  }
  const mimeType = pickMimeType();
  const chunks = [];
  const recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  const subject = state.subject;
  state.recorder = recorder;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    clearRecordingUi();
    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
    finishCapture(blob, mimeType.includes('mp4') ? 'mp4' : 'webm', subject);
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

// Hand the capture to the upload queue, thank the participant, and clear the form for the next one.
function finishCapture(blob, extension, subject) {
  state.busy = false;
  if (!blob || blob.size === 0) {
    setStatus('Nothing was captured. Please try again.', true);
    render();
    return;
  }
  enqueueUpload(blob, extension, subject);
  const firstName = subject.name.split(/\s+/)[0];
  stageDoneText.textContent = `Thank you, ${firstName}! Your response has been recorded.`;
  state.done = true;
  clearTimeout(state.doneTimer);
  state.doneTimer = setTimeout(hideDone, DONE_SCREEN_MS);
  resetParticipant();
  nextParticipantBtn.focus();
}

function hideDone() {
  clearTimeout(state.doneTimer);
  state.doneTimer = null;
  if (!state.done) return;
  state.done = false;
  render();
}

nextParticipantBtn.addEventListener('click', () => {
  hideDone();
  subjectName.focus();
});

// ---------- Background upload ----------

async function readErrorDetail(response) {
  try {
    const body = await response.json();
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join('; ');
  } catch {
    // Not JSON — fall through to the status text.
  }
  return `the server responded with ${response.status} ${response.statusText}`.trim();
}

function enqueueUpload(blob, extension, subject) {
  const formData = new FormData();
  formData.append('file', blob, `capture.${extension}`);
  formData.append('subject_id', subject.subject_id);
  formData.append('name', subject.name);
  formData.append('roll_no', subject.roll_no);
  formData.append('age', subject.age);
  formData.append('gender', subject.gender);
  formData.append('diet', subject.diet);
  uploads.queue.push({ formData, name: subject.name });
  processUploads();
}

async function processUploads() {
  if (uploads.active || uploads.retryTimer || uploads.queue.length === 0) {
    renderUploadState();
    return;
  }
  const item = uploads.queue[0];
  uploads.active = true;
  renderUploadState();
  try {
    const response = await fetch('/collect/submit', { method: 'POST', body: item.formData });
    if (response.ok) {
      uploads.saved += 1;
      uploads.error = '';
      uploads.queue.shift();
    } else if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
      // Retrying will not help a request the server refuses; drop it and tell the operator.
      const detail = await readErrorDetail(response);
      console.error(`Capture for ${item.name} rejected: ${detail}`);
      uploads.rejected += 1;
      uploads.queue.shift();
    } else {
      throw new Error(await readErrorDetail(response));
    }
  } catch (err) {
    uploads.error = err instanceof TypeError ? 'could not reach the server' : err.message;
    uploads.retryTimer = setTimeout(() => {
      uploads.retryTimer = null;
      processUploads();
    }, UPLOAD_RETRY_MS);
  } finally {
    uploads.active = false;
  }
  processUploads();
}

window.addEventListener('beforeunload', (event) => {
  if (uploads.queue.length > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// ---------- Init ----------

render();
subjectName.focus();
