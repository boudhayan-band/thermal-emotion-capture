// Thermal page: participant -> RGB photo (optional) + thermal file -> combined result.
// Separate from /capture/ and /collect/; posts to /thermal/predict.

const $ = (id) => document.getElementById(id);

const SUBJECT_STORAGE_KEY = 'thermalCapture.subject';
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
const REGION_ORDER = [
  'face', 'forehead', 'right_inner_canthus', 'left_inner_canthus', 'right_periorbital', 'left_periorbital',
  'nose', 'nose_tip', 'right_cheek', 'left_cheek', 'mouth', 'chin',
];

const subjectForm = $('subjectForm');
const subjectName = $('subjectName');
const subjectAge = $('subjectAge');
const stage = $('stage');
const video = $('preview');
const rgbStill = $('rgbStill');
const statusEl = $('status');
const resultDialog = $('resultDialog');

const state = {
  subject: null,
  editing: false,
  stream: null,
  busy: false,
  rgbSource: 'camera',
  thermalSource: 'file',
  rgbBlob: null, // { blob, name, preview }
  thermalFile: null,
  thermalFrom: 'upload', // 'upload' | 'agent'
  thermalDevice: '',
  agent: { active: false, connected: false, loop: 0, status: null, previewUrl: null, capturedUrl: null },
  history: [],
};

// ---------- helpers ----------

const emotionInfo = (name) => EMOTIONS[name] || EMOTIONS.Unknown;
const pct = (v) => `${Math.round(Number(v) * 100)}%`;
const signed = (v) => `${Number(v) >= 0 ? '+' : '−'}${Math.abs(Number(v)).toFixed(2)}`;
const fmtC = (v) => (v == null ? '—' : Number(v).toFixed(1));

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
    /* storage unavailable */
  }
}

function newSubjectId() {
  const id = window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32);
  return `sub_${id.replaceAll('-', '')}`;
}

// ---------- render ----------

function render() {
  const hasSubject = Boolean(state.subject);
  const showForm = !hasSubject || state.editing;
  const ready = hasSubject && !state.editing;

  subjectForm.hidden = !showForm;
  $('subjectSummary').hidden = showForm;
  $('subjectCancelBtn').hidden = !(hasSubject && state.editing);
  $('subjectSubmitBtn').textContent = hasSubject && state.editing ? 'Save changes' : 'Save & continue';
  $('editSubjectBtn').disabled = state.busy;
  $('newSubjectBtn').disabled = state.busy;
  if (hasSubject) {
    $('subjectAvatar').textContent = state.subject.name.charAt(0).toUpperCase();
    $('summaryName').textContent = state.subject.name;
    $('summaryDetails').textContent = `Age ${state.subject.age} · ${state.subject.gender} · ${state.subject.diet}`;
    $('summaryId').textContent = state.subject.subject_id;
  }

  $('captureLocked').hidden = ready;
  ['rgbCard', 'thermalCard'].forEach((id) => $(id).classList.toggle('is-disabled', !ready || state.busy));

  // RGB camera
  $('rgbCameraPane').hidden = state.rgbSource !== 'camera';
  $('rgbFilePane').hidden = state.rgbSource !== 'file';
  const live = Boolean(state.stream);
  stage.classList.toggle('is-live', live);
  $('stageEmpty').hidden = live;
  const hasStill = state.rgbSource === 'camera' && Boolean(state.rgbBlob);
  stage.classList.toggle('has-still', hasStill);
  rgbStill.hidden = !hasStill;
  video.hidden = hasStill;
  if (!window.isSecureContext) {
    $('stageEmptyText').textContent = 'The camera only works over a secure https:// connection.';
    $('startBtn').disabled = true;
  } else {
    $('startBtn').disabled = !ready;
  }
  $('snapBtn').hidden = hasStill;
  $('snapBtn').disabled = !(live && ready) || state.busy;
  $('retakeBtn').hidden = !hasStill;

  $('rgbCard').classList.toggle('is-ready', Boolean(state.rgbBlob));
  $('rgbState').textContent = state.rgbBlob
    ? `RGB photo ready (${state.rgbBlob.name}).`
    : 'No RGB photo yet — thermal analysis still works without it.';

  // Thermal
  $('thermalFilePane').hidden = state.thermalSource !== 'file';
  $('thermalAgentPane').hidden = state.thermalSource !== 'agent';
  $('thermalCard').classList.toggle('is-ready', Boolean(state.thermalFile));
  $('thermalState').textContent = state.thermalFile
    ? (state.thermalFrom === 'agent' ? `Thermal frame captured from ${state.thermalDevice}.` : `Thermal file ready (${state.thermalFile.name}).`)
    : state.thermalSource === 'agent' ? 'No thermal frame captured yet.' : 'No thermal file yet.';

  // Live thermal (agent)
  const agentLive = state.agent.connected;
  const captured = Boolean(state.agent.capturedUrl);
  $('agentPreview').hidden = !(agentLive || captured);
  if (captured) $('agentPreview').src = state.agent.capturedUrl;
  $('agentEmpty').hidden = agentLive || captured;
  $('agentBadge').hidden = !(agentLive || captured);
  $('agentCaptureBtn').disabled = !ready || state.busy || !(agentLive || captured);
  $('agentCaptureBtn').textContent = captured
    ? 'Retake thermal'
    : state.rgbSource === 'camera' && state.stream && !state.rgbBlob ? 'Capture RGB + thermal' : 'Capture thermal';
  $('agentRotateBtn').disabled = !agentLive || captured || state.busy;
  $('agentShutterBtn').disabled = !agentLive || captured || state.busy;
  $('agentConnectBtn').textContent = state.agent.active ? 'Disconnect' : 'Connect';

  const canAnalyze = ready && Boolean(state.thermalFile) && !state.busy;
  $('analyzeBtn').disabled = !canAnalyze;
  $('analyzeHint').textContent = !ready
    ? 'Save participant details first.'
    : !state.thermalFile
      ? 'Add a thermal file to analyze.'
      : state.rgbBlob
        ? 'Ready: RGB (emotion) + thermal.'
        : 'Ready: thermal only (add an RGB photo to also get emotion).';
  $('busy').hidden = !state.busy;

  const current = resultDialog.open ? 3 : ready ? 2 : 1;
  [1, 2, 3].forEach((n) => {
    const step = $(`step${n}`);
    step.classList.toggle('is-active', n === current);
    step.classList.toggle('is-done', n < current);
    if (n === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });

  $('historySection').hidden = state.history.length === 0;
}

// ---------- participant ----------

function setFieldError(key, message) {
  const el = subjectForm.querySelector(`.field-error[data-for="${key}"]`);
  el.textContent = message || '';
  el.closest('.field').classList.toggle('has-error', Boolean(message));
}

function validateSubjectForm() {
  const name = subjectName.value.trim();
  const age = Number(subjectAge.value);
  const gender = subjectForm.querySelector('input[name="gender"]:checked');
  const diet = subjectForm.querySelector('input[name="diet"]:checked');
  setFieldError('subjectName', name ? '' : 'Please enter a name.');
  setFieldError('subjectAge', subjectAge.value && Number.isInteger(age) && age >= 1 && age <= 120 ? '' : 'Enter an age between 1 and 120.');
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
  subjectForm.querySelectorAll('input[name="gender"]').forEach((i) => { i.checked = Boolean(subject) && i.value === subject.gender; });
  subjectForm.querySelectorAll('input[name="diet"]').forEach((i) => { i.checked = Boolean(subject) && i.value === subject.diet; });
  ['subjectName', 'subjectAge', 'gender', 'diet'].forEach((k) => setFieldError(k, ''));
}

subjectForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const values = validateSubjectForm();
  if (!values) return;
  const subjectId = state.subject && state.editing ? state.subject.subject_id : newSubjectId();
  state.subject = { subject_id: subjectId, ...values };
  state.editing = false;
  storeSubject(state.subject);
  setStatus('');
  render();
});
subjectForm.addEventListener('input', (e) => {
  const key = ['diet', 'gender'].includes(e.target.name) ? e.target.name : e.target.id;
  if (key) setFieldError(key, '');
});
$('subjectCancelBtn').addEventListener('click', () => { state.editing = false; render(); });
$('editSubjectBtn').addEventListener('click', () => {
  fillSubjectForm(state.subject);
  state.editing = true;
  render();
  subjectName.focus();
});

function clearCaptureInputs() {
  state.rgbBlob = null;
  $('rgbFile').value = '';
  $('rgbFileLabel').textContent = 'Choose a .jpg / .png photo';
  $('rgbFilePreview').hidden = true;
  clearThermal();
}

function startNewParticipant() {
  state.subject = null;
  state.editing = false;
  storeSubject(null);
  fillSubjectForm(null);
  clearCaptureInputs();
  render();
  subjectName.focus();
}
$('newSubjectBtn').addEventListener('click', startNewParticipant);

// ---------- RGB ----------

document.querySelectorAll('input[name="rgbSource"]').forEach((input) => {
  input.addEventListener('change', () => {
    state.rgbSource = input.value;
    state.rgbBlob = null;
    $('rgbFile').value = '';
    $('rgbFilePreview').hidden = true;
    $('rgbFileLabel').textContent = 'Choose a .jpg / .png photo';
    render();
  });
});

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
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const activeId = state.stream && state.stream.getVideoTracks()[0]?.getSettings().deviceId;
  const select = $('cameraSelect');
  select.innerHTML = '';
  cams.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
    if (cam.deviceId === activeId) opt.selected = true;
    select.appendChild(opt);
  });
  // An iPhone (Continuity Camera) often connects a few seconds after the first camera starts:
  // keep the picker visible while the camera is on, and let the user re-scan.
  const refresh = document.createElement('option');
  refresh.value = REFRESH_CAMERAS;
  refresh.textContent = cams.length < 2 ? '↻ Look for more cameras (iPhone…)' : '↻ Refresh camera list';
  select.appendChild(refresh);
  select.hidden = !state.stream;
}

const REFRESH_CAMERAS = '__refresh__';
const CAMERA_KEY = 'thermal.cameraId';
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => { if (state.stream) listCameras().catch(() => {}); });
}

async function startSavedCamera() {
  const saved = localStorage.getItem(CAMERA_KEY);
  if (saved) {
    try { await startCamera(saved); return; } catch { /* that camera is not available now */ }
  }
  await startCamera();
}

async function startCamera(deviceId) {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' },
  });
  state.stream = stream;
  video.srcObject = stream;
  if (deviceId) localStorage.setItem(CAMERA_KEY, deviceId);
}

$('startBtn').addEventListener('click', async () => {
  const btn = $('startBtn');
  btn.disabled = true;
  btn.textContent = 'Waiting for permission…';
  try {
    await startSavedCamera();
    await listCameras();
    setStatus('');
  } catch (err) {
    $('stageEmptyText').textContent = describeCameraError(err);
  } finally {
    btn.textContent = 'Turn on camera';
    render();
  }
});

$('cameraSelect').addEventListener('change', async () => {
  const value = $('cameraSelect').value;
  try {
    if (value !== REFRESH_CAMERAS) await startCamera(value);
  } catch (err) {
    setStatus(describeCameraError(err), true);
  }
  await listCameras(); // re-scan and re-select the camera in use
  render();
});

function snapRgb() {
  return new Promise((resolve) => {
    const canvas = $('snapshotCanvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL('image/jpeg', 0.92);
    canvas.toBlob((blob) => {
      state.rgbBlob = { blob, name: 'camera photo', preview, filename: 'rgb.jpg' };
      rgbStill.src = preview;
      render();
      resolve();
    }, 'image/jpeg', 0.92);
  });
}

$('snapBtn').addEventListener('click', snapRgb);

$('retakeBtn').addEventListener('click', () => {
  state.rgbBlob = null;
  render();
});

$('rgbFile').addEventListener('change', () => {
  const file = $('rgbFile').files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  state.rgbBlob = { blob: file, name: file.name, preview: url, filename: file.name };
  $('rgbFileLabel').textContent = file.name;
  $('rgbFilePreview').src = url;
  $('rgbFilePreview').hidden = false;
  render();
});

// ---------- Thermal ----------

document.querySelectorAll('input[name="thermalSource"]').forEach((input) => {
  input.addEventListener('change', () => {
    state.thermalSource = input.value;
    clearThermal();
    if (input.value !== 'agent') stopAgent();
    render();
  });
});

$('thermalFile').addEventListener('change', () => {
  const file = $('thermalFile').files[0];
  state.thermalFile = file || null;
  state.thermalFrom = 'upload';
  state.thermalDevice = '';
  $('thermalFileLabel').textContent = file ? file.name : 'Choose a temperature map (.npy / .csv) or thermal image';
  render();
});

function clearThermal() {
  state.thermalFile = null;
  state.thermalFrom = 'upload';
  state.thermalDevice = '';
  $('thermalFile').value = '';
  $('thermalFileLabel').textContent = 'Choose a temperature map (.npy / .csv) or thermal image';
  if (state.agent.capturedUrl) URL.revokeObjectURL(state.agent.capturedUrl);
  state.agent.capturedUrl = null;
}

// ---------- Live thermal (thermal-agent on this laptop) ----------

const agentBase = () => $('agentUrl').value.trim().replace(/\/+$/, '');

// Safari cannot use the agent's plain-HTTP port from this HTTPS page; it uses the agent's HTTPS port (8766).
const IS_SAFARI = /^((?!chrome|chromium|crios|fxios|edg|opr|android).)*safari/i.test(navigator.userAgent);
const AGENT_HTTP_URL = 'http://127.0.0.1:8765';
const AGENT_HTTPS_URL = 'https://localhost:8766';
if (IS_SAFARI && $('agentUrl').value.trim() === AGENT_HTTP_URL) $('agentUrl').value = AGENT_HTTPS_URL;

function agentHelp(err) {
  const base = agentBase();
  const detail = err && err.message && !(err instanceof TypeError) ? ` (${err.message})` : '';
  if (IS_SAFARI) {
    if (!base.startsWith('https://')) {
      return `Safari cannot reach ${base} from this page. Use ${AGENT_HTTPS_URL} (agent 0.3.0 or later).${detail}`;
    }
    return `Could not reach thermal-agent at ${base}. Check that agent 0.3.0 or later is running in Terminal and that `
      + 'you trusted its certificate (the sudo security add-trusted-cert command it prints). To test, open '
      + `${base}/status in a new tab: if Safari says the connection is not private, the certificate is not trusted yet.${detail}`;
  }
  return `Could not reach thermal-agent at ${base}. Check that it is running in Terminal, and that you clicked "Allow" `
    + `if Chrome asked to access devices on your local network. In Safari, use ${AGENT_HTTPS_URL}.${detail}`;
}

async function agentFetch(path, options = {}) {
  const response = await fetch(`${agentBase()}${path}`, { cache: 'no-store', ...options });
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = (await response.json()).error || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return response;
}

async function refreshAgentStatus() {
  const status = await (await agentFetch('/status')).json();
  state.agent.status = status;
  const dev = status.device && (status.device.model || status.device.product) ? (status.device.model || status.device.product) : 'camera';
  $('agentStatus').textContent = status.connected
    ? `${status.demo ? 'DEMO · ' : ''}${dev} · ${status.fps} fps · rotation ${status.rotation}°`
    : `Agent running, waiting for the camera${status.error ? `: ${status.error}` : '…'}`;
  return status;
}

async function previewLoop(token) {
  let lastStatus = 0;
  while (state.agent.loop === token) {
    if (state.agent.capturedUrl || state.busy || document.hidden) {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    try {
      if (performance.now() - lastStatus > 2000) {
        await refreshAgentStatus();
        lastStatus = performance.now();
      }
      const response = await agentFetch('/preview.jpg');
      const url = URL.createObjectURL(await response.blob());
      if (state.agent.previewUrl) URL.revokeObjectURL(state.agent.previewUrl);
      state.agent.previewUrl = url;
      $('agentPreview').src = url;
      const min = response.headers.get('X-Temp-Min');
      const max = response.headers.get('X-Temp-Max');
      $('agentBadge').textContent = min && max ? `${Number(min).toFixed(1)} – ${Number(max).toFixed(1)} °C` : 'live';
      $('agentBadge').classList.remove('is-captured');
      if (!state.agent.connected) { state.agent.connected = true; render(); }
    } catch (err) {
      const camWaiting = err instanceof Error && !(err instanceof TypeError);
      $('agentEmptyText').textContent = camWaiting ? `Agent running, but no camera frames yet: ${err.message}` : agentHelp(err);
      if (state.agent.connected) { state.agent.connected = false; render(); }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 100)); // ~8 fps preview is plenty
  }
}

function stopAgent() {
  state.agent.loop += 1; // ends any running loop
  state.agent.active = false;
  state.agent.connected = false;
  $('agentConnectBtn').textContent = 'Connect';
}

$('agentConnectBtn').addEventListener('click', async () => {
  if (state.agent.active) { // connecting/connected -> disconnect
    stopAgent();
    $('agentStatus').textContent = 'Disconnected.';
    render();
    return;
  }
  state.agent.loop += 1;
  state.agent.active = true;
  $('agentConnectBtn').textContent = 'Disconnect';
  $('agentEmptyText').textContent = 'Connecting…';
  previewLoop(state.agent.loop);
});

$('agentRotateBtn').addEventListener('click', async () => {
  try { await agentFetch('/rotate', { method: 'POST' }); await refreshAgentStatus(); } catch (err) { setStatus(agentHelp(err), true); }
});

$('agentShutterBtn').addEventListener('click', async () => {
  try {
    await agentFetch('/shutter', { method: 'POST' });
    $('agentStatus').textContent = 'Recalibrated (shutter). Wait a second before capturing.';
  } catch (err) { setStatus(agentHelp(err), true); }
});

$('agentCaptureBtn').addEventListener('click', async () => {
  if (state.agent.capturedUrl) { // "Retake"
    clearThermal();
    render();
    return;
  }
  const alsoRgb = state.rgbSource === 'camera' && state.stream && !state.rgbBlob;
  try {
    // Fire both at the same moment so the RGB photo and thermal frame match.
    const [response] = await Promise.all([agentFetch('/capture.npy'), alsoRgb ? snapRgb() : Promise.resolve()]);
    const blob = await response.blob();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    state.thermalFile = new File([blob], `tc01a_${stamp}.npy`, { type: 'application/octet-stream' });
    state.thermalFrom = 'agent';
    state.thermalDevice = response.headers.get('X-Device') || 'TC01A';
    state.agent.capturedUrl = state.agent.previewUrl; // freeze the preview on the captured frame
    state.agent.previewUrl = null;
    const min = response.headers.get('X-Temp-Min');
    const max = response.headers.get('X-Temp-Max');
    $('agentBadge').textContent = `Captured · ${Number(min).toFixed(1)} – ${Number(max).toFixed(1)} °C`;
    $('agentBadge').classList.add('is-captured');
    setStatus('');
  } catch (err) {
    setStatus(err instanceof TypeError ? agentHelp(err) : `Thermal capture failed: ${err.message}`, true);
  }
  render();
});

// ---------- Analyze ----------

async function readErrorDetail(response) {
  try {
    const body = await response.json();
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join('; ');
  } catch {
    /* not JSON */
  }
  return `The server responded with ${response.status} ${response.statusText}`.trim();
}

$('analyzeBtn').addEventListener('click', async () => {
  const s = state.subject;
  const fd = new FormData();
  fd.append('thermal_file', state.thermalFile, state.thermalFile.name);
  if (state.rgbBlob) fd.append('rgb_file', state.rgbBlob.blob, state.rgbBlob.filename);
  fd.append('subject_id', s.subject_id);
  fd.append('name', s.name);
  fd.append('age', s.age);
  fd.append('gender', s.gender);
  fd.append('diet', s.diet);
  const fromAgent = state.thermalFrom === 'agent';
  fd.append('temp_unit', fromAgent ? 'C' : $('tempUnit').value); // the agent always sends degrees C
  fd.append('source', fromAgent ? 'agent' : 'upload');
  if (fromAgent) fd.append('device', state.thermalDevice);

  state.busy = true;
  setStatus('');
  render();
  try {
    const response = await fetch('/thermal/predict', { method: 'POST', body: fd });
    if (!response.ok) throw new Error(await readErrorDetail(response));
    const data = await response.json();
    const entry = { data, rgbPreview: state.rgbBlob ? state.rgbBlob.preview : null, at: new Date() };
    state.history.unshift(entry);
    renderHistory();
    state.busy = false;
    clearCaptureInputs();
    openResult(entry);
  } catch (err) {
    state.busy = false;
    setStatus(err instanceof TypeError
      ? 'Could not reach the server. Check your connection and try again.'
      : `Analysis failed: ${err.message}`, true);
  }
  render();
});

// ---------- Results ----------

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function openResult(entry) {
  const { data } = entry;
  const emo = data.emotion;
  const th = data.thermal;

  $('resultParticipant').textContent = `${data.name} · ${entry.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  // Emotion
  const hasEmotion = emo && emo.emotion && emo.emotion !== 'Unknown';
  const info = emotionInfo(hasEmotion ? emo.emotion : 'Unknown');
  resultDialog.style.setProperty('--emotion', info.color);
  $('resultRgb').hidden = !entry.rgbPreview;
  if (entry.rgbPreview) $('resultRgb').src = entry.rgbPreview;
  $('emotionBlock').hidden = !hasEmotion;
  if (hasEmotion) {
    $('resultEmoji').textContent = info.emoji;
    $('resultEmotionText').textContent = emo.emotion;
    $('confidenceValue').textContent = pct(emo.confidence);
    $('confidenceBar').style.width = '0';
    requestAnimationFrame(() => { $('confidenceBar').style.width = pct(emo.confidence); });
    const hasAffect = emo.valence != null && emo.arousal != null;
    $('affectBlock').hidden = !hasAffect;
    if (hasAffect) {
      $('valenceValue').textContent = signed(emo.valence);
      $('arousalValue').textContent = signed(emo.arousal);
    }
  }
  $('emotionMessage').textContent = !emo
    ? 'No RGB photo was captured, so no emotion was estimated.'
    : hasEmotion ? '' : (emo.message || 'No face found in the RGB photo.');

  // Thermal
  $('resultOverlay').src = th.overlay || '';
  $('occludedValue').textContent = `${th.occluded_count} / 68`;
  $('frameRange').textContent = th.frame_temp_c ? `${fmtC(th.frame_temp_c.min)} – ${fmtC(th.frame_temp_c.max)} °C` : 'no temperatures';
  $('thermalMessage').textContent = th.message || '';

  const regionsBody = $('regionsBody');
  regionsBody.innerHTML = '';
  $('regionsBlock').hidden = !th.regions;
  if (th.regions) {
    REGION_ORDER.forEach((key) => {
      const r = th.regions[key];
      if (!r) return;
      const tr = document.createElement('tr');
      if (r.occluded_fraction >= 0.5) tr.className = 'is-occluded';
      tr.append(cell(r.label), cell(fmtC(r.mean_c)), cell(fmtC(r.min_c)), cell(fmtC(r.max_c)), cell(pct(r.occluded_fraction)));
      regionsBody.appendChild(tr);
    });
  }

  const lmBody = $('landmarksBody');
  lmBody.innerHTML = '';
  th.landmarks.forEach((l) => {
    const tr = document.createElement('tr');
    if (l.occluded) tr.className = 'is-occluded';
    tr.append(cell(l.index), cell(l.x.toFixed(1)), cell(l.y.toFixed(1)), cell(fmtC(l.temp_c)),
      cell(`${pct(l.occlusion_prob)}${l.occluded ? ' · occluded' : ''}`));
    lmBody.appendChild(tr);
  });

  const links = $('mediaLinks');
  links.innerHTML = '';
  const m = data.media || {};
  [['rgb_url', 'RGB photo'], ['thermal_url', 'Thermal upload'], ['temp_map_url', 'Temperature map (.npy)'], ['overlay_url', 'Overlay']]
    .forEach(([key, label]) => {
      if (!m[key]) return;
      const a = document.createElement('a');
      a.href = m[key];
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = 'Requires the admin login';
      a.textContent = `${label} ↗`;
      links.appendChild(a);
    });

  if (!resultDialog.open) resultDialog.showModal();
  resultDialog.querySelector('.result-body').scrollTop = 0;
  render();
}

function closeResult() {
  if (resultDialog.open) resultDialog.close();
}
$('closeDialogBtn').addEventListener('click', closeResult);
$('captureAgainBtn').addEventListener('click', closeResult);
$('newParticipantFromResultBtn').addEventListener('click', () => { closeResult(); startNewParticipant(); });
resultDialog.addEventListener('close', render);
resultDialog.addEventListener('click', (e) => { if (e.target === resultDialog) closeResult(); });

// ---------- History ----------

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  state.history.forEach((entry) => {
    const { data } = entry;
    const emo = data.emotion;
    const hasEmotion = emo && emo.emotion && emo.emotion !== 'Unknown';
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    const img = document.createElement('img');
    img.src = data.thermal.overlay || entry.rgbPreview || '';
    img.alt = '';
    const main = document.createElement('div');
    main.className = 'h-main';
    const title = document.createElement('div');
    title.className = 'h-emotion';
    const face = data.thermal.regions && data.thermal.regions.face;
    title.textContent = [
      hasEmotion ? `${emotionInfo(emo.emotion).emoji} ${emo.emotion}` : null,
      face && face.mean_c != null ? `${fmtC(face.mean_c)} °C face` : null,
    ].filter(Boolean).join(' · ') || 'Thermal landmarks';
    const sub = document.createElement('div');
    sub.className = 'h-sub';
    sub.textContent = `${data.name} · ${entry.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    main.append(title, sub);
    btn.append(img, main);
    btn.addEventListener('click', () => openResult(entry));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

// ---------- init ----------

state.subject = loadStoredSubject();
render();
if (!state.subject) subjectName.focus();
