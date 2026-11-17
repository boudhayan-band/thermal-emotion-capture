// Synced capture: one button fires the RGB camera and the TC01A thermal camera together.
// Photo -> /thermal/predict, Video (5 s or 10 s) -> /thermal/predict_video.
// A copy of /thermal/ with its own page state; the original page is unchanged.

const $ = (id) => document.getElementById(id);

const SUBJECT_STORAGE_KEY = 'thermalSync.subject';
const RECORD_FPS = 10; // thermal frames per second in a video clip
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
const QUALITY_LABEL = { good: 'Good', fair: 'Fair', poor: 'Poor', no_temperature: 'No temperature' };

const subjectForm = $('subjectForm');
const subjectName = $('subjectName');
const subjectAge = $('subjectAge');
const stage = $('stage');
const video = $('preview');
const rgbReview = $('rgbReview');
const rgbStill = $('rgbStill');
const statusEl = $('status');
const resultDialog = $('resultDialog');

const state = {
  subject: null,
  editing: false,
  stream: null,
  busy: false,
  mode: 'photo', // 'photo' | 'video'
  duration: 5,
  recording: null, // { startedAt, seconds, timer }
  capture: null, // see capturePhoto() / captureVideo()
  agent: { active: false, connected: false, loop: 0, status: null, previewUrl: null, recFrames: null, recT0: 0 },
  flip: { raf: 0 },
  history: [],
  rgbSource: 'laptop', // 'laptop' | 'phone'
  remoteWait: null,    // text while waiting for the phone
};

// ---------- helpers ----------

const emotionInfo = (name) => EMOTIONS[name] || EMOTIONS.Unknown;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v) => `${Math.round(Number(v) * 100)}%`;
const signed = (v, d = 2) => (isNum(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '—');
const fmtC = (v) => (v == null ? '—' : Number(v).toFixed(1));
const fmtCU = (v) => (v == null ? '—' : `${Number(v).toFixed(1)} °C`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const recording = Boolean(state.recording);
  const captured = Boolean(state.capture);
  const locked = state.busy || recording || Boolean(state.remoteWait);

  subjectForm.hidden = !showForm;
  $('subjectSummary').hidden = showForm;
  $('subjectCancelBtn').hidden = !(hasSubject && state.editing);
  $('subjectSubmitBtn').textContent = hasSubject && state.editing ? 'Save changes' : 'Save & continue';
  $('editSubjectBtn').disabled = locked;
  $('newSubjectBtn').disabled = locked;
  if (hasSubject) {
    $('subjectAvatar').textContent = state.subject.name.charAt(0).toUpperCase();
    $('summaryName').textContent = state.subject.name;
    $('summaryDetails').textContent = `Age ${state.subject.age} · ${state.subject.gender} · ${state.subject.diet}`;
    $('summaryId').textContent = state.subject.subject_id;
  }

  $('captureLocked').hidden = ready;
  $('modeBar').classList.toggle('is-disabled', !ready || locked || captured);
  document.querySelectorAll('input[name="captureMode"], input[name="duration"]').forEach((i) => {
    i.disabled = !ready || locked || captured;
  });
  $('durationGroup').hidden = state.mode !== 'video';
  $('modeNote').textContent = state.mode === 'video'
    ? `One press records ${state.duration} s from both cameras at the same moment.`
    : 'One press takes an RGB photo and a thermal frame at the same moment.';
  ['rgbCard', 'thermalCard'].forEach((id) => $(id).classList.toggle('is-disabled', !ready || state.busy));

  // RGB stage
  const live = rgbLive();
  const c = state.capture;
  const showStill = Boolean(c && c.kind === 'photo');
  const showReview = Boolean(c && c.kind === 'video');
  stage.classList.toggle('is-live', live);
  stage.classList.toggle('has-still', showStill);
  stage.classList.toggle('has-review', showReview);
  stage.classList.toggle('is-recording', recording);
  $('stageEmpty').hidden = live || captured || isPhoneSource();
  rgbStill.hidden = !showStill;
  rgbReview.hidden = !showReview;
  video.hidden = showStill || showReview;
  if (!window.isSecureContext) {
    $('stageEmptyText').textContent = 'The camera only works over a secure https:// connection.';
    $('startBtn').disabled = true;
  } else {
    $('startBtn').disabled = !ready;
  }
  $('cameraSelect').disabled = locked || captured;
  $('cameraSelect').hidden = isPhoneSource() || !state.stream;
  renderPhone(captured, locked);

  // Thermal stage
  const agentLive = state.agent.connected;
  $('agentPreview').hidden = !(agentLive || captured);
  $('agentEmpty').hidden = agentLive || captured;
  $('agentBadge').hidden = !(agentLive || captured);
  $('agentRotateBtn').disabled = !agentLive || captured || locked;
  $('agentShutterBtn').disabled = !agentLive || captured || locked;
  $('agentConnectBtn').textContent = state.agent.active ? 'Disconnect' : 'Connect';
  $('agentConnectBtn').disabled = locked;

  setPill($('rgbReady'), recording ? 'rec' : captured ? 'captured' : live ? 'ready' : 'off');
  setPill($('thermalReady'), recording ? 'rec' : captured ? 'captured' : agentLive ? 'ready' : 'off');

  // Capture / review buttons
  const btn = $('captureBtn');
  btn.hidden = captured;
  btn.classList.toggle('is-video', state.mode === 'video');
  btn.classList.toggle('is-recording', recording);
  btn.disabled = !ready || !live || !agentLive || locked;
  $('captureLabel').textContent = recording
    ? 'Recording…'
    : state.mode === 'video' ? `Record ${state.duration} s video` : 'Capture photo';
  $('reviewActions').hidden = !captured;
  $('analyzeBtn').disabled = state.busy;
  $('retakeBtn').disabled = state.busy;

  const missing = [];
  if (!live) {
    if (!isPhoneSource()) missing.push('turn on the RGB camera');
    else if (!remote.phone.connected) missing.push('pair the phone (scan the QR code)');
    else if (!remote.phone.camera_on) missing.push('start the camera on the phone');
    else missing.push('bring the phone page to the front');
  }
  if (!agentLive) missing.push('connect the thermal camera');
  $('captureHint').textContent = !ready
    ? 'Save participant details first.'
    : state.remoteWait ? state.remoteWait
    : recording ? 'Hold still — both cameras are recording.'
      : captured ? (c.kind === 'video'
        ? `Recorded ${c.duration} s from both cameras (${c.thermal.frames} thermal frames). Review, then Analyze.`
        : 'Photo and thermal frame captured together. Review, then Analyze.')
        : missing.length ? `To capture: ${missing.join(' and ')}.` : 'Both cameras ready.';
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

function setPill(node, kind) {
  node.textContent = { off: 'off', ready: 'ready', rec: 'rec', captured: 'captured' }[kind];
  node.classList.toggle('is-on', kind === 'ready' || kind === 'captured');
  node.classList.toggle('is-rec', kind === 'rec');
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

function startNewParticipant() {
  state.subject = null;
  state.editing = false;
  storeSubject(null);
  fillSubjectForm(null);
  clearCapture();
  render();
  subjectName.focus();
}
$('newSubjectBtn').addEventListener('click', startNewParticipant);

// ---------- mode ----------

document.querySelectorAll('input[name="captureMode"]').forEach((input) => {
  input.addEventListener('change', () => { state.mode = input.value; render(); });
});
document.querySelectorAll('input[name="duration"]').forEach((input) => {
  input.addEventListener('change', () => { state.duration = Number(input.value); render(); });
});

// ---------- RGB camera ----------

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
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
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
    canvas.toBlob((blob) => resolve({ blob, preview, filename: 'rgb.jpg' }), 'image/jpeg', 0.92);
  });
}

function pickRecorderType() {
  const types = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
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
  const old = !(status.features || []).includes('record');
  $('agentStatus').textContent = (status.connected
    ? `${status.demo ? 'DEMO · ' : ''}${dev} · ${status.fps} fps · rotation ${status.rotation}° · agent ${status.version}`
    : `Agent running, waiting for the camera${status.error ? `: ${status.error}` : '…'}`)
    + (old ? ' · This agent is too old to record video. Download thermal_agent.py again.' : '');
  return status;
}

function badgeRange(min, max, prefix = '') {
  const badge = $('agentBadge');
  badge.textContent = min && max ? `${prefix}${Number(min).toFixed(1)} – ${Number(max).toFixed(1)} °C` : prefix || 'live';
}

async function previewLoop(token) {
  let lastStatus = 0;
  while (state.agent.loop === token) {
    if (state.capture || state.busy || document.hidden) {
      await sleep(300);
      continue;
    }
    try {
      if (!state.recording && performance.now() - lastStatus > 2000) {
        await refreshAgentStatus();
        lastStatus = performance.now();
      }
      const response = await agentFetch('/preview.jpg');
      const url = URL.createObjectURL(await response.blob());
      if (state.agent.recFrames) {
        // Keep every preview taken while recording for the thermal playback next to the RGB video.
        const pt = performance.now();
        state.agent.recFrames.push({ t: (pt - state.agent.recT0) / 1000, pt, url });
      } else if (state.agent.previewUrl && !isRecFrame(state.agent.previewUrl)) {
        URL.revokeObjectURL(state.agent.previewUrl);
      }
      state.agent.previewUrl = url;
      if (!state.capture) $('agentPreview').src = url;
      badgeRange(response.headers.get('X-Temp-Min'), response.headers.get('X-Temp-Max'));
      $('agentBadge').classList.remove('is-captured');
      if (!state.agent.connected) { state.agent.connected = true; render(); }
    } catch (err) {
      const camWaiting = err instanceof Error && !(err instanceof TypeError);
      $('agentEmptyText').textContent = camWaiting ? `Agent running, but no camera frames yet: ${err.message}` : agentHelp(err);
      if (state.agent.connected) { state.agent.connected = false; render(); }
      await sleep(1500);
    }
    await sleep(state.recording ? 60 : 100);
  }
}

const isRecFrame = (url) => Boolean(state.capture && state.capture.thermal && state.capture.thermal.flipbook
  && state.capture.thermal.flipbook.some((f) => f.url === url));

function stopAgent() {
  state.agent.loop += 1; // ends any running loop
  state.agent.active = false;
  state.agent.connected = false;
}

$('agentConnectBtn').addEventListener('click', async () => {
  if (state.agent.active) {
    stopAgent();
    $('agentStatus').textContent = 'Disconnected.';
    render();
    return;
  }
  state.agent.loop += 1;
  state.agent.active = true;
  $('agentEmptyText').textContent = 'Connecting…';
  render();
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

// ---------- Phone as the RGB camera (/thermal-remote/) ----------
// The phone joins this page's pairing session through the server. Capture sends the phone a start
// time in server-clock ms; the thermal capture runs here at that same moment. The phone uploads its
// full-quality file to the server, and Analyze names it (remote_upload) instead of sending RGB bytes.

const REMOTE_TOKEN_KEY = 'thermalSync.remoteToken';
const RGB_SOURCE_KEY = 'thermalSync.rgbSource';
const PHOTO_LEAD_MS = 450;   // time for the capture message to reach the phone
const VIDEO_LEAD_MS = 700;

const remote = {
  token: null, code: '', joinUrl: '', ws: null, wsOpen: false, retry: 0, stopped: false, connecting: false,
  clock: { offset: 0, samples: [] },
  phone: { connected: false },
  previewUrl: null, lastFrameAt: 0,
  pending: null, // { id, kind, recording, captured, uploaded (deferreds), progress }
  showPair: false,
};

const remoteNow = () => Date.now() + remote.clock.offset;
const isPhoneSource = () => state.rgbSource === 'phone';
const phoneReady = () => remote.wsOpen && remote.phone.connected && remote.phone.camera_on && remote.phone.visible !== false;
const rgbLive = () => (isPhoneSource() ? phoneReady() : Boolean(state.stream));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // rejections are handled where awaited
  return { promise, resolve, reject };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function captureId() {
  const id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`;
  return `rc_${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
}

async function ensureRemoteSession(fresh = false) {
  if (remote.connecting) return;
  remote.connecting = true;
  remote.stopped = false;
  $('pairStatus').textContent = 'Preparing a pairing code…';
  $('pairStatus').classList.remove('is-error');
  try {
    const fd = new FormData();
    const saved = fresh ? null : sessionStorage.getItem(REMOTE_TOKEN_KEY);
    if (saved) fd.append('host_token', saved);
    const response = await fetch('/thermal/remote/session', { method: 'POST', body: fd });
    if (!response.ok) throw new Error(await readErrorDetail(response));
    const data = await response.json();
    remote.token = data.host_token;
    remote.code = data.code;
    remote.joinUrl = data.join_url;
    remote.phone = data.phone || { connected: false };
    try { sessionStorage.setItem(REMOTE_TOKEN_KEY, data.host_token); } catch { /* ignore */ }
    $('pairQr').innerHTML = data.qr_svg; // generated by our server from the join URL
    $('pairCode').textContent = data.code;
    const url = new URL(data.join_url);
    $('pairUrlHost').textContent = `${url.host}${url.pathname}`;
    connectRemote();
  } catch (err) {
    $('pairStatus').textContent = `Could not create a pairing code: ${err.message}`;
    $('pairStatus').classList.add('is-error');
  } finally {
    remote.connecting = false;
    render();
  }
}

function connectRemote() {
  if (remote.ws) { remote.ws.onclose = null; remote.ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/thermal/remote/ws?role=host&token=${encodeURIComponent(remote.token)}`);
  ws.binaryType = 'blob';
  remote.ws = ws;
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') onRemoteMessage(JSON.parse(e.data));
    else onPhoneFrame(e.data);
  };
  ws.onclose = (e) => {
    if (remote.ws !== ws) return;
    remote.wsOpen = false;
    remote.phone = { ...remote.phone, connected: false };
    failPending(new Error('Lost the connection to the server.'));
    if (e.code === 4404 || e.code === 4410) { // session expired: start a new one
      sessionStorage.removeItem(REMOTE_TOKEN_KEY);
      if (isPhoneSource()) ensureRemoteSession(true);
    } else if (e.code === 4001) {
      remote.stopped = true;
      $('pairStatus').textContent = 'Phone pairing moved to another tab with this page. Reload to use it here.';
    } else if (!remote.stopped) {
      setTimeout(() => { if (!remote.stopped && isPhoneSource()) connectRemote(); }, Math.min(10000, 500 * 2 ** remote.retry++));
    }
    render();
  };
}

function onRemoteMessage(msg) {
  const p = remote.pending;
  const mine = p && msg.capture_id === p.id;
  switch (msg.type) {
    case 'hello':
      remote.wsOpen = true;
      remote.retry = 0;
      remote.phone = msg.phone || { connected: false };
      syncRemoteClock(8);
      break;
    case 'pong': {
      const t1 = Date.now();
      const rtt = t1 - msg.t0;
      if (!(rtt >= 0 && rtt < 5000)) break;
      const s = remote.clock.samples;
      s.push({ rtt, offset: msg.ts - (msg.t0 + t1) / 2 });
      while (s.length > 20) s.shift();
      const best = [...s].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
      remote.clock.offset = best.reduce((acc, x) => acc + x.offset, 0) / best.length;
      break;
    }
    case 'phone': {
      const wasConnected = remote.phone.connected;
      remote.phone = msg;
      if (msg.connected && !wasConnected) remote.showPair = false;
      if (!msg.connected || !msg.camera_on) $('phonePreview').hidden = true;
      if (!msg.connected) failPending(new Error('The phone disconnected.'));
      break;
    }
    case 'recording': if (mine) p.recording.resolve(msg); break;
    case 'captured': if (mine) p.captured.resolve(msg); break;
    case 'upload_progress':
      if (mine && msg.total) { p.progress = msg.loaded / msg.total; updateRemoteWait(); }
      break;
    case 'uploaded': if (mine) p.uploaded.resolve(msg); break;
    case 'error':
      if (mine || !msg.capture_id) failPending(new Error(msg.message || 'The phone reported an error.'));
      break;
    default: break;
  }
  render();
}

function sendRemote(obj) {
  if (remote.ws && remote.ws.readyState === WebSocket.OPEN) { remote.ws.send(JSON.stringify(obj)); return true; }
  return false;
}

async function syncRemoteClock(n) {
  for (let i = 0; i < n; i += 1) { sendRemote({ type: 'ping', t0: Date.now() }); await sleep(120); }
}
setInterval(() => { if (remote.wsOpen) sendRemote({ type: 'ping', t0: Date.now() }); }, 10000);

function onPhoneFrame(blob) {
  if (!isPhoneSource() || state.capture) return;
  const url = URL.createObjectURL(blob);
  const img = $('phonePreview');
  const old = remote.previewUrl;
  remote.previewUrl = url;
  remote.lastFrameAt = performance.now();
  img.src = url;
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  if (img.hidden) render();
}

function failPending(err) {
  const p = remote.pending;
  if (!p) return;
  p.recording.reject(err);
  p.captured.reject(err);
  p.uploaded.reject(err);
}

function updateRemoteWait() {
  const p = remote.pending;
  if (!p || !state.remoteWait) return;
  const pctText = p.progress != null ? ` ${Math.round(p.progress * 100)}%` : '';
  state.remoteWait = `${p.kind === 'video' ? 'Receiving the phone video' : 'Receiving the phone photo'}…${pctText}`;
}

async function waitUntilServer(serverMs) {
  for (;;) {
    const left = serverMs - remoteNow();
    if (left <= 0) return;
    await sleep(left > 30 ? left - 20 : Math.max(1, left / 2));
  }
}

async function fetchStaged(uploaded) {
  const response = await fetch(`/thermal/remote/staged/${encodeURIComponent(uploaded.upload_id)}?token=${encodeURIComponent(remote.token)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(await readErrorDetail(response));
  return response.blob();
}

function startPending(kind) {
  remote.pending = {
    id: captureId(), kind, progress: null,
    recording: deferred(), captured: deferred(), uploaded: deferred(),
  };
  return remote.pending;
}

function endPending(cancel) {
  const p = remote.pending;
  if (p && cancel) sendRemote({ type: 'cancel', capture_id: p.id });
  remote.pending = null;
  state.remoteWait = null;
}

async function capturePhotoPhone() {
  const p = startPending('photo');
  const atMs = remoteNow() + PHOTO_LEAD_MS;
  if (!sendRemote({ type: 'capture', capture_id: p.id, mode: 'photo', at_ms: atMs })) throw new Error('Not connected to the phone.');
  try {
    await waitUntilServer(atMs);
    const thermalMs = remoteNow();
    const response = await agentFetch('/capture.npy');
    const blob = await response.blob();
    const min = response.headers.get('X-Temp-Min');
    const max = response.headers.get('X-Temp-Max');
    $('agentPreview').src = state.agent.previewUrl || '';
    state.remoteWait = 'Receiving the phone photo…';
    render();
    const captured = await withTimeout(p.captured.promise, 8000, 'The phone did not take the photo. Check the phone page.');
    const uploaded = await withTimeout(p.uploaded.promise, 90000, 'The phone photo did not arrive. Check the phone connection.');
    const rgbBlob = await fetchStaged(uploaded);
    const preview = URL.createObjectURL(rgbBlob);
    state.capture = {
      kind: 'photo',
      rgb: { blob: rgbBlob, preview, filename: `phone${uploaded.suffix || '.jpg'}`, remote: { uploadId: uploaded.upload_id } },
      skewMs: Math.round((captured.started_ms || uploaded.started_ms) - thermalMs),
      thermal: {
        file: new File([blob], `tc01a_${stamp()}.npy`, { type: 'application/octet-stream' }),
        device: response.headers.get('X-Device') || 'TC01A',
        previewUrl: state.agent.previewUrl,
      },
    };
    rgbStill.src = preview;
    badgeRange(min, max, 'Captured · ');
    $('agentBadge').classList.add('is-captured');
    endPending(false);
  } catch (err) {
    endPending(true);
    throw err;
  }
}

async function captureVideoPhone() {
  const seconds = state.duration;
  const p = startPending('video');
  const atMs = remoteNow() + VIDEO_LEAD_MS;
  if (!sendRemote({ type: 'capture', capture_id: p.id, mode: 'video', duration: seconds, at_ms: atMs })) {
    throw new Error('Not connected to the phone.');
  }
  state.recording = { seconds, timer: null };
  state.remoteWait = 'Starting both cameras…';
  render();
  let response;
  let flipbook = [];
  try {
    try {
      await waitUntilServer(atMs);
    state.remoteWait = null;
    state.agent.recFrames = [];
    state.agent.recT0 = performance.now();
    state.recording.timer = showRecording(seconds);
    render();
      const thermalReq = agentFetch(`/record.npz?seconds=${seconds}&fps=${RECORD_FPS}`);
      thermalReq.catch(() => {});
      const rec = await withTimeout(p.recording.promise, 6000, 'The phone did not start recording. Check the phone page.');
      // Line the thermal flipbook up with the phone's actual start.
      state.agent.recT0 = performance.now() - (remoteNow() - rec.started_ms);
      response = await thermalReq;
    } finally {
      if (state.recording) clearInterval(state.recording.timer);
      state.recording = null;
      hideRecording();
      flipbook = (state.agent.recFrames || []).map((f) => ({ ...f, t: (f.pt - state.agent.recT0) / 1000 }));
      state.agent.recFrames = null;
    }
    const clip = await response.blob();
    state.remoteWait = 'Receiving the phone video…';
    render();
    const rec = await p.recording.promise;
    const uploaded = await withTimeout(p.uploaded.promise, 180000, 'The phone video did not arrive. Check the phone connection.');
    const rgbBlob = await fetchStaged(uploaded);
    const thermalStartLocal = Number(response.headers.get('X-Record-Start'));
    const offsetMs = isNum(thermalStartLocal) && thermalStartLocal > 0
      ? rec.started_ms - (thermalStartLocal + remote.clock.offset) : 0;
    const rgbUrl = URL.createObjectURL(rgbBlob);
    state.capture = {
      kind: 'video',
      duration: seconds,
      offsetMs: Math.round(offsetMs),
      rgb: { blob: rgbBlob, url: rgbUrl, filename: `phone${uploaded.suffix || '.mp4'}`, remote: { uploadId: uploaded.upload_id } },
      thermal: {
        file: new File([clip], `tc01a_${stamp()}_${seconds}s.npz`, { type: 'application/octet-stream' }),
        device: response.headers.get('X-Device') || 'TC01A',
        frames: Number(response.headers.get('X-Frames')) || 0,
        flipbook,
      },
    };
    badgeRange(response.headers.get('X-Temp-Min'), response.headers.get('X-Temp-Max'), `Recorded ${seconds} s · `);
    $('agentBadge').classList.add('is-captured');
    rgbReview.src = rgbUrl;
    fixDuration(rgbReview);
    rgbReview.play().catch(() => {});
    startFlipbook();
    endPending(false);
  } catch (err) {
    flipbook.forEach((f) => { if (f.url !== state.agent.previewUrl) URL.revokeObjectURL(f.url); });
    endPending(true);
    throw err;
  }
}

function setRgbSource(source) {
  state.rgbSource = source === 'phone' ? 'phone' : 'laptop';
  try { localStorage.setItem(RGB_SOURCE_KEY, state.rgbSource); } catch { /* ignore */ }
  document.querySelectorAll('input[name="rgbSource"]').forEach((i) => { i.checked = i.value === state.rgbSource; });
  if (isPhoneSource() && (!remote.token || remote.stopped || !remote.ws)) ensureRemoteSession();
  render();
}

document.querySelectorAll('input[name="rgbSource"]').forEach((input) => {
  input.addEventListener('change', () => setRgbSource(input.value));
});
$('pairShowBtn').addEventListener('click', () => { remote.showPair = true; render(); });
$('pairCloseBtn').addEventListener('click', () => { remote.showPair = false; render(); });

function renderPhone(captured, locked) {
  const phone = isPhoneSource();
  const ph = remote.phone || {};
  stage.classList.toggle('is-phone', phone);
  $('phoneRow').hidden = !phone || (!captured && !ph.connected && remote.wsOpen);
  document.querySelectorAll('input[name="rgbSource"]').forEach((i) => { i.disabled = locked || captured || Boolean(state.remoteWait); });
  if (!phone) {
    $('pairBox').hidden = true;
    $('phonePreview').hidden = true;
    $('phoneChip').hidden = true;
    return;
  }
  const showPair = !captured && (!ph.connected || remote.showPair);
  $('pairBox').hidden = !showPair;
  $('pairCloseBtn').hidden = !(ph.connected && remote.showPair);
  const fresh = performance.now() - remote.lastFrameAt < 3000;
  $('phonePreview').hidden = captured || showPair || !ph.connected || !ph.camera_on || !remote.previewUrl || !fresh;
  $('phoneChip').hidden = !ph.connected || captured;
  $('phoneChip').textContent = [ph.model, ph.camera].filter(Boolean).join(' · ') || 'Phone';
  $('stageEmpty').hidden = true;
  $('cameraSelect').hidden = true;
  $('pairShowBtn').hidden = !ph.connected || showPair;
  $('pairShowBtn').disabled = locked;

  let text; let warn = false;
  if (!remote.wsOpen) { text = remote.stopped ? $('pairStatus').textContent : 'Connecting to the server…'; warn = true; }
  else if (!ph.connected) text = 'Waiting for a phone to scan the code…';
  else if (!ph.camera_on) { text = `${ph.model || 'Phone'} paired. Tap “Start camera” on the phone.`; warn = true; }
  else if (ph.visible === false) { text = `${ph.model || 'Phone'}: the page is in the background. Bring it to the front.`; warn = true; }
  else text = `${ph.model || 'Phone'} ready${ph.width ? ` · ${ph.width}×${ph.height}` : ''}.`;
  $('phoneStatus').textContent = text;
  $('phoneStatus').classList.toggle('is-warn', warn);
  if (remote.wsOpen && !remote.stopped) $('pairStatus').textContent = ph.connected ? `Paired with ${ph.model || 'a phone'}. Scanning with another phone replaces it.` : 'Waiting for the phone…';
}

// Re-check the preview freshness now and then (frames stop when the phone page is hidden).
setInterval(() => { if (isPhoneSource()) render(); }, 1500);

// ---------- Capture (one button, both cameras) ----------

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function capturePhoto() {
  // Fire both at the same moment so the RGB photo and the thermal frame match.
  const [response, rgb] = await Promise.all([agentFetch('/capture.npy'), snapRgb()]);
  const blob = await response.blob();
  const min = response.headers.get('X-Temp-Min');
  const max = response.headers.get('X-Temp-Max');
  state.capture = {
    kind: 'photo',
    rgb,
    thermal: {
      file: new File([blob], `tc01a_${stamp()}.npy`, { type: 'application/octet-stream' }),
      device: response.headers.get('X-Device') || 'TC01A',
      previewUrl: state.agent.previewUrl,
    },
  };
  rgbStill.src = rgb.preview;
  $('agentPreview').src = state.agent.previewUrl || '';
  badgeRange(min, max, 'Captured · ');
  $('agentBadge').classList.add('is-captured');
}

function showRecording(seconds) {
  document.querySelectorAll('[data-rec]').forEach((n) => { n.hidden = false; });
  document.querySelectorAll('[data-rec-progress]').forEach((n) => {
    n.hidden = false;
    n.style.setProperty('--rec-duration', `${seconds}s`);
    n.classList.remove('is-running');
    void n.offsetWidth; // restart the CSS animation
    n.classList.add('is-running');
  });
  const t0 = performance.now();
  const tick = () => {
    const left = Math.max(0, seconds - (performance.now() - t0) / 1000);
    document.querySelectorAll('[data-rec-text]').forEach((n) => { n.textContent = `REC ${left.toFixed(1)} s`; });
  };
  tick();
  return setInterval(tick, 100);
}

function hideRecording() {
  document.querySelectorAll('[data-rec], [data-rec-progress]').forEach((n) => { n.hidden = true; });
  document.querySelectorAll('[data-rec-progress]').forEach((n) => n.classList.remove('is-running'));
}

async function captureVideo() {
  const seconds = state.duration;
  const mimeType = pickRecorderType();
  if (!mimeType) throw new Error('This browser cannot record video. Use Chrome or Safari 14.1 or later.');
  const recorder = new MediaRecorder(state.stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const rgbStarted = new Promise((resolve) => { recorder.onstart = () => resolve(Date.now()); });
  const rgbStopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = (e) => reject(e.error || new Error('RGB recording failed'));
  });

  state.agent.recFrames = [];
  state.agent.recT0 = performance.now();
  state.recording = { seconds, timer: showRecording(seconds) };
  render();

  // Start both recorders together. The agent records for `seconds` and answers with the whole clip.
  const thermalReq = agentFetch(`/record.npz?seconds=${seconds}&fps=${RECORD_FPS}`);
  thermalReq.catch(() => { if (recorder.state === 'recording') recorder.stop(); });
  recorder.start(250);
  const rgbStartMs = await rgbStarted;
  state.agent.recT0 = performance.now();
  const stopTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, seconds * 1000);

  let response;
  try {
    [response] = await Promise.all([thermalReq, rgbStopped]);
  } finally {
    clearTimeout(stopTimer);
    if (recorder.state === 'recording') recorder.stop();
    clearInterval(state.recording.timer);
    state.recording = null;
    hideRecording();
  }
  const flipbook = state.agent.recFrames || [];
  state.agent.recFrames = null;

  const clip = await response.blob();
  const thermalStartMs = Number(response.headers.get('X-Record-Start'));
  const offsetMs = isNum(thermalStartMs) && thermalStartMs > 0 ? rgbStartMs - thermalStartMs : 0;
  const isMp4 = mimeType.startsWith('video/mp4');
  const rgbBlob = new Blob(chunks, { type: mimeType.split(';')[0] });
  if (!rgbBlob.size) throw new Error('The RGB recording came out empty. Try again.');
  const rgbUrl = URL.createObjectURL(rgbBlob);

  state.capture = {
    kind: 'video',
    duration: seconds,
    offsetMs: Math.round(offsetMs),
    rgb: { blob: rgbBlob, url: rgbUrl, filename: `rgb.${isMp4 ? 'mp4' : 'webm'}` },
    thermal: {
      file: new File([clip], `tc01a_${stamp()}_${seconds}s.npz`, { type: 'application/octet-stream' }),
      device: response.headers.get('X-Device') || 'TC01A',
      frames: Number(response.headers.get('X-Frames')) || 0,
      flipbook,
    },
  };
  badgeRange(response.headers.get('X-Temp-Min'), response.headers.get('X-Temp-Max'), `Recorded ${seconds} s · `);
  $('agentBadge').classList.add('is-captured');
  rgbReview.src = rgbUrl;
  fixDuration(rgbReview);
  rgbReview.play().catch(() => {});
  startFlipbook();
}

// Chrome's MediaRecorder writes WebM without a duration, so the seek bar would not work; seeking far
// past the end once makes the browser work it out.
function fixDuration(el) {
  el.addEventListener('loadedmetadata', function onMeta() {
    el.removeEventListener('loadedmetadata', onMeta);
    if (el.duration !== Infinity) return;
    el.addEventListener('durationchange', function onChange() {
      el.removeEventListener('durationchange', onChange);
      el.currentTime = 0;
    });
    el.currentTime = 1e7;
  });
}

// Plays the thermal previews taken during recording in step with the RGB review video.
function startFlipbook() {
  cancelAnimationFrame(state.flip.raf);
  const c = state.capture;
  if (!c || c.kind !== 'video' || !c.thermal.flipbook.length) return;
  const frames = c.thermal.flipbook;
  let shown = null;
  const step = () => {
    if (!state.capture || state.capture !== c) return;
    const t = rgbReview.currentTime;
    let pick = frames[0];
    for (const f of frames) { if (f.t <= t) pick = f; else break; }
    if (pick.url !== shown) { $('agentPreview').src = pick.url; shown = pick.url; }
    state.flip.raf = requestAnimationFrame(step);
  };
  step();
}

function clearCapture() {
  cancelAnimationFrame(state.flip.raf);
  const c = state.capture;
  if (c) {
    if (c.kind === 'video') {
      rgbReview.pause();
      rgbReview.removeAttribute('src');
      rgbReview.load();
      URL.revokeObjectURL(c.rgb.url);
      c.thermal.flipbook.forEach((f) => { if (f.url !== state.agent.previewUrl) URL.revokeObjectURL(f.url); });
    }
  }
  state.capture = null;
  $('agentBadge').classList.remove('is-captured');
}

$('captureBtn').addEventListener('click', async () => {
  if (!rgbLive() || !state.agent.connected || state.recording || state.remoteWait) return;
  setStatus('');
  try {
    if (isPhoneSource()) {
      if (state.mode === 'video') await captureVideoPhone();
      else await capturePhotoPhone();
    } else if (state.mode === 'video') await captureVideo();
    else await capturePhoto();
  } catch (err) {
    clearCapture();
    setStatus(err instanceof TypeError ? agentHelp(err) : `Capture failed: ${err.message}`, true);
  }
  render();
});

$('retakeBtn').addEventListener('click', () => {
  clearCapture();
  setStatus('');
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

function appendRemote(fd, c) {
  fd.append('remote_token', remote.token || '');
  fd.append('remote_upload', c.rgb.remote.uploadId);
}

$('analyzeBtn').addEventListener('click', async () => {
  const s = state.subject;
  const c = state.capture;
  if (!c) return;
  const fd = new FormData();
  fd.append('subject_id', s.subject_id);
  fd.append('name', s.name);
  fd.append('age', s.age);
  fd.append('gender', s.gender);
  fd.append('diet', s.diet);
  fd.append('device', c.thermal.device);
  fd.append('page', 'thermal-sync');
  let url;
  if (c.kind === 'video') {
    url = '/thermal/predict_video';
    fd.append('thermal_clip', c.thermal.file, c.thermal.file.name);
    if (c.rgb.remote) appendRemote(fd, c);
    else fd.append('rgb_video', c.rgb.blob, c.rgb.filename);
    fd.append('duration', String(c.duration));
    fd.append('sync_offset_ms', String(c.offsetMs));
    $('busyText').textContent = `Analyzing ${c.duration} s of RGB and thermal video… this takes about ${c.duration * 3} s.`;
  } else {
    url = '/thermal/predict';
    fd.append('thermal_file', c.thermal.file, c.thermal.file.name);
    if (c.rgb.remote) {
      appendRemote(fd, c);
      if (isNum(c.skewMs)) fd.append('sync_skew_ms', String(c.skewMs));
    } else fd.append('rgb_file', c.rgb.blob, c.rgb.filename);
    fd.append('temp_unit', 'C'); // the agent always sends degrees C
    fd.append('source', 'agent');
    $('busyText').textContent = 'Analyzing RGB and thermal…';
  }

  state.busy = true;
  setStatus('');
  render();
  try {
    const response = await fetch(url, { method: 'POST', body: fd });
    if (!response.ok) throw new Error(await readErrorDetail(response));
    const data = await response.json();
    const entry = {
      data,
      kind: c.kind,
      rgbPreview: c.kind === 'photo' ? c.rgb.preview : null,
      rgbVideo: c.kind === 'video' ? URL.createObjectURL(c.rgb.blob) : null,
      at: new Date(),
    };
    state.history.unshift(entry);
    renderHistory();
    state.busy = false;
    clearCapture();
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

function cell(text, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function openResult(entry) {
  const { data } = entry;
  const isVideo = entry.kind === 'video';
  const emo = data.emotion;
  const th = data.thermal;
  const der = th.derived || {};

  $('resultTitle').textContent = isVideo ? `Thermal + emotion result · ${data.duration} s video` : 'Thermal + emotion result · photo';
  $('resultParticipant').textContent = `${data.name} · ${entry.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  // Emotion
  const hasEmotion = emo && emo.emotion && emo.emotion !== 'Unknown';
  const info = emotionInfo(hasEmotion ? emo.emotion : 'Unknown');
  resultDialog.style.setProperty('--emotion', info.color);
  $('resultRgb').hidden = isVideo || !entry.rgbPreview;
  if (!isVideo && entry.rgbPreview) $('resultRgb').src = entry.rgbPreview;
  const rv = $('resultRgbVideo');
  rv.hidden = !isVideo || !entry.rgbVideo;
  if (isVideo && entry.rgbVideo) { rv.src = entry.rgbVideo; fixDuration(rv); rv.play().catch(() => {}); } else { rv.pause(); rv.removeAttribute('src'); }
  const emoFrameCount = emo && emo.frames ? emo.frames.length : 0;
  $('emotionSub').textContent = !isVideo ? 'from RGB' : emoFrameCount ? `averaged over ${emoFrameCount} frames` : 'from RGB video';
  $('emotionBlock').hidden = !hasEmotion;
  if (hasEmotion) {
    $('resultEmoji').textContent = info.emoji;
    $('resultEmotionText').textContent = emo.emotion;
    $('confidenceValue').textContent = pct(emo.confidence);
    $('confidenceBar').style.width = '0';
    requestAnimationFrame(() => { $('confidenceBar').style.width = pct(emo.confidence); });
    const hasAffect = emo.valence != null && emo.arousal != null;
    $('affectBlock').hidden = !hasAffect;
    $('valenceLabel').textContent = isVideo ? 'Mean valence' : 'Valence';
    $('arousalLabel').textContent = isVideo ? 'Mean arousal' : 'Arousal';
    if (hasAffect) {
      $('valenceValue').textContent = signed(emo.valence);
      $('arousalValue').textContent = signed(emo.arousal);
    }
  }
  $('emotionMessage').textContent = !emo
    ? 'No RGB was captured, so no emotion was estimated.'
    : hasEmotion ? (isVideo ? emo.message || '' : '') : (emo.message || 'No face found in the RGB capture.');

  // Thermal
  $('thermalSub').textContent = isVideo ? `clip average · overlay at ${th.representative_t} s` : 'landmarks & occlusion';
  $('resultOverlay').src = th.overlay || '';
  $('occludedLabel').textContent = isVideo ? 'Occluded points (avg)' : 'Occluded points';
  $('occludedValue').textContent = `${th.occluded_count} / 68`;
  $('frameRange').textContent = th.frame_temp_c ? `${fmtC(th.frame_temp_c.min)} – ${fmtC(th.frame_temp_c.max)} °C` : 'no temperatures';
  $('canthusValue').textContent = der.canthus_max_c == null ? '—' : `${fmtCU(der.canthus_max_c)}${der.elevated_temp ? ' · elevated' : ''}`;
  $('canthusValue').classList.toggle('is-elevated', Boolean(der.elevated_temp));
  $('noseDeltaValue').textContent = der.nose_forehead_delta_c == null ? '—' : `${signed(der.nose_forehead_delta_c, 1)} °C`;
  $('asymValue').textContent = der.canthus_asymmetry_c == null ? '—' : `${signed(der.canthus_asymmetry_c, 1)} °C`;
  $('qualityValue').textContent = QUALITY_LABEL[der.quality] || '—';
  $('qualityValue').className = der.quality ? `q-${der.quality}` : '';
  $('thermalMessage').textContent = th.message || '';

  // Timeline
  $('timelineBlock').hidden = !isVideo;
  if (isVideo) requestAnimationFrame(() => drawTimeline(th.frames || [], (emo && emo.frames) || [], data.duration));

  // Regions
  $('regionsHead').innerHTML = isVideo
    ? '<tr><th>Region</th><th>Mean</th><th>Min</th><th>Max</th><th title="Last sample minus first">Change</th><th title="Straight-line trend over the clip">°C/min</th><th title="Share of the region\'s landmarks predicted as occluded">Occl.</th></tr>'
    : '<tr><th>Region</th><th>Mean</th><th>Min</th><th>Max</th><th title="Share of the region\'s landmarks predicted as occluded">Occl.</th></tr>';
  const regionsBody = $('regionsBody');
  regionsBody.innerHTML = '';
  $('regionsBlock').hidden = !th.regions;
  if (th.regions) {
    REGION_ORDER.forEach((key) => {
      const r = th.regions[key];
      if (!r) return;
      const tr = document.createElement('tr');
      if (r.occluded_fraction >= 0.5) tr.className = 'is-occluded';
      tr.append(cell(r.label), cell(fmtC(r.mean_c)), cell(fmtC(r.min_c)), cell(fmtC(r.max_c)));
      if (isVideo) tr.append(cell(r.change_c == null ? '—' : signed(r.change_c, 2)), cell(r.slope_c_per_min == null ? '—' : signed(r.slope_c_per_min, 2)));
      tr.append(cell(pct(r.occluded_fraction)));
      regionsBody.appendChild(tr);
    });
  }

  // Landmark video (video)
  const lv = $('landmarkVideo');
  $('landmarkVideoBlock').hidden = !isVideo || !th.landmark_video;
  if (isVideo && th.landmark_video) {
    lv.src = th.landmark_video;
    $('landmarkVideoSub').textContent = `All ${th.clip ? th.clip.frames : ''} thermal frames with their own 68 landmarks, at ${th.clip && th.clip.fps ? th.clip.fps : 10} fps · green visible, red occluded.`;
  } else { lv.pause(); lv.removeAttribute('src'); }

  // Frames table (video)
  $('framesDetails').hidden = !isVideo;
  const fb = $('framesBody');
  fb.innerHTML = '';
  resultFrames = isVideo ? (th.frames || []) : [];
  $('framesDetails').open = isVideo && resultFrames.some((f) => f.image);
  if (isVideo) {
    const emoFrames = (emo && emo.frames) || [];
    const nearestEmo = (t) => {
      let best = null;
      for (const f of emoFrames) if (!best || Math.abs(f.timestamp - t) < Math.abs(best.timestamp - t)) best = f;
      return best && Math.abs(best.timestamp - t) <= 0.3 ? best : null;
    };
    (th.frames || []).forEach((f, k) => {
      const d = f.derived || {};
      const e = nearestEmo(f.t_sync);
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.title = 'Show this frame\'s landmarks';
      tr.addEventListener('click', () => selectFrame(k));
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectFrame(k); } });
      tr.append(cell(f.t_sync.toFixed(1)), cell(fmtC(d.face_mean_c)), cell(fmtC(d.canthus_max_c)), cell(fmtC(d.nose_tip_c)),
        cell(fmtC(d.forehead_mean_c)), cell(String(f.occluded_count)), cell(e ? e.emotion : '—'),
        cell(e ? signed(e.valence) : '—'), cell(e ? signed(e.arousal) : '—'));
      fb.appendChild(tr);
    });
  }

  resultRepLandmarks = { landmarks: th.landmarks, label: isVideo ? `· representative frame, t = ${th.representative_t} s (thermal clock)` : '' };
  const repK = resultFrames.findIndex((f) => f.t === th.representative_t && f.image);
  if (repK >= 0) selectFrame(repK);
  else { $('frameViewer').hidden = true; renderLandmarks(resultRepLandmarks.landmarks, resultRepLandmarks.label); }

  const links = $('mediaLinks');
  links.innerHTML = '';
  const m = data.media || {};
  [['rgb_url', isVideo ? 'RGB video' : 'RGB photo'], ['thermal_url', isVideo ? 'Thermal clip (.npz)' : 'Thermal frame (.npy)'],
    ['thermal_preview_url', 'Thermal video'], ['landmark_video_url', 'Landmark video'], ['temp_map_url', 'Temperature map (.npy)'], ['overlay_url', 'Overlay']]
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

// ---------- Per-frame landmarks (video results) ----------

let resultFrames = [];
let resultRepLandmarks = null;
let selectedFrame = -1;

function renderLandmarks(landmarks, label) {
  $('landmarksSub').textContent = label || '';
  const lmBody = $('landmarksBody');
  lmBody.innerHTML = '';
  (landmarks || []).forEach((l) => {
    const tr = document.createElement('tr');
    if (l.occluded) tr.className = 'is-occluded';
    tr.append(cell(l.index), cell(l.x.toFixed(1)), cell(l.y.toFixed(1)), cell(fmtC(l.temp_c)),
      cell(`${pct(l.occlusion_prob)}${l.occluded ? ' · occluded' : ''}`));
    lmBody.appendChild(tr);
  });
}

function selectFrame(k) {
  const f = resultFrames[k];
  if (!f) return;
  selectedFrame = k;
  $('framesBody').querySelectorAll('tr').forEach((tr, i) => tr.classList.toggle('is-selected', i === k));
  const viewer = $('frameViewer');
  viewer.hidden = !f.image;
  if (f.image) $('frameImage').src = f.image;
  const d = f.derived || {};
  $('frameCaption').textContent = `Frame ${k + 1} of ${resultFrames.length} · t = ${f.t_sync.toFixed(1)} s · `
    + `occluded ${f.occluded_count}/68 · face ${fmtC(d.face_mean_c)} °C · eye corner ${fmtC(d.canthus_max_c)} °C`;
  $('framePrevBtn').disabled = k <= 0;
  $('frameNextBtn').disabled = k >= resultFrames.length - 1;
  if (f.landmarks) renderLandmarks(f.landmarks, `· frame at t = ${f.t_sync.toFixed(1)} s`);
  else if (resultRepLandmarks) renderLandmarks(resultRepLandmarks.landmarks, resultRepLandmarks.label);
}

$('framePrevBtn').addEventListener('click', () => selectFrame(selectedFrame - 1));
$('frameNextBtn').addEventListener('click', () => selectFrame(selectedFrame + 1));
$('frameViewer').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') selectFrame(selectedFrame - 1);
  if (e.key === 'ArrowRight') selectFrame(selectedFrame + 1);
});

// Line chart: temperature series on the left axis, valence / arousal on the right axis.
function drawTimeline(thermalFrames, emoFrames, duration) {
  const box = $('timelineChart');
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, parent, text) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  };
  const series = [
    { key: 'face_mean_c', label: 'Face mean', color: '#eb6834' },
    { key: 'canthus_max_c', label: 'Inner eye corner (max)', color: '#e5484d' },
    { key: 'forehead_mean_c', label: 'Forehead', color: '#c58a00' },
    { key: 'nose_tip_c', label: 'Nose tip', color: '#2a78d6' },
  ];
  const affect = [
    { key: 'valence', label: 'Valence', color: '#1baf7a' },
    { key: 'arousal', label: 'Arousal', color: '#8e5cd9' },
  ];
  const W = Math.max(320, box.clientWidth || 640);
  const H = 240;
  const m = { l: 44, r: 40, t: 10, b: 28 };
  const temps = thermalFrames.flatMap((f) => series.map((s) => (f.derived || {})[s.key])).filter(isNum);
  box.innerHTML = '';
  if (!temps.length && !emoFrames.length) {
    box.innerHTML = '<p class="muted small">No readings over time.</p>';
    return;
  }
  let lo = temps.length ? Math.min(...temps) : 30;
  let hi = temps.length ? Math.max(...temps) : 37;
  if (hi - lo < 1) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const tMax = Math.max(duration, ...thermalFrames.map((f) => f.t_sync), ...emoFrames.map((f) => f.timestamp));
  const x = (t) => m.l + (Math.max(0, t) / (tMax || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const ya = (v) => m.t + (1 - (v + 1) / 2) * (H - m.t - m.b);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Temperatures and emotion over the clip' }, box);

  const step = (hi - lo) > 4 ? 1 : (hi - lo) > 2 ? 0.5 : 0.25;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    mk('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }, svg);
    mk('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg, String(Number(v.toFixed(2))));
  }
  [-1, 0, 1].forEach((v) => mk('text', { x: W - m.r + 6, y: ya(v) + 4 }, svg, v > 0 ? '+1' : String(v)));
  mk('line', { x1: m.l, x2: W - m.r, y1: ya(0), y2: ya(0), class: 'zero' }, svg);
  for (let t = 0; t <= tMax + 1e-6; t += tMax > 6 ? 2 : 1) {
    mk('text', { x: x(t), y: H - 8, 'text-anchor': 'middle' }, svg, `${t}s`);
  }
  mk('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'axis' }, svg);

  const path = (pts) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  const legend = [];
  series.forEach((s) => {
    const pts = thermalFrames.filter((f) => isNum((f.derived || {})[s.key])).map((f) => [x(f.t_sync), y(f.derived[s.key])]);
    if (pts.length < 1) return;
    mk('path', { d: path(pts), class: 'line', stroke: s.color }, svg);
    if (pts.length === 1) mk('circle', { cx: pts[0][0], cy: pts[0][1], r: 3, fill: s.color }, svg);
    legend.push(`<span><i style="background:${s.color}"></i>${s.label}</span>`);
  });
  affect.forEach((s) => {
    const pts = emoFrames.filter((f) => isNum(f[s.key])).map((f) => [x(f.timestamp), ya(f[s.key])]);
    if (pts.length < 1) return;
    mk('path', { d: path(pts), class: 'line dashed', stroke: s.color }, svg);
    legend.push(`<span style="color:${s.color}"><i class="dashed"></i>${s.label}</span>`);
  });
  $('timelineLegend').innerHTML = legend.join('');
}

function closeResult() {
  if (resultDialog.open) resultDialog.close();
}
$('closeDialogBtn').addEventListener('click', closeResult);
$('captureAgainBtn').addEventListener('click', closeResult);
$('newParticipantFromResultBtn').addEventListener('click', () => { closeResult(); startNewParticipant(); });
resultDialog.addEventListener('close', () => { $('resultRgbVideo').pause(); $('landmarkVideo').pause(); render(); });
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
    const der = data.thermal.derived || {};
    title.textContent = [
      hasEmotion ? `${emotionInfo(emo.emotion).emoji} ${emo.emotion}` : null,
      der.canthus_max_c != null ? `${fmtC(der.canthus_max_c)} °C eye` : null,
    ].filter(Boolean).join(' · ') || 'Thermal landmarks';
    const sub = document.createElement('div');
    sub.className = 'h-sub';
    sub.textContent = `${entry.kind === 'video' ? `${data.duration} s video` : 'Photo'} · ${entry.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    main.append(title, sub);
    btn.append(img, main);
    btn.addEventListener('click', () => openResult(entry));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

// ---------- init ----------

state.subject = loadStoredSubject();
let savedSource = 'laptop';
try { savedSource = localStorage.getItem(RGB_SOURCE_KEY) || 'laptop'; } catch { /* ignore */ }
setRgbSource(savedSource);
render();
if (!state.subject) subjectName.focus();
