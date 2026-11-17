// Remote camera (phone) for the Synced Capture page.
// Joins the laptop's pairing session over a WebSocket, streams small preview frames, and takes the
// photo / records the video when the laptop says so, at the agreed server-clock time. The full-quality
// file is uploaded to the server; the laptop then analyzes it together with the thermal capture.

const $ = (id) => document.getElementById(id);
const video = $('preview');
const stage = $('stage');

const PREVIEW_WIDTH = 480;          // px, preview frames for the laptop
const PREVIEW_MIN_INTERVAL = 220;   // ms between preview frames (about 4 per second)
const ACK_TIMEOUT = 2500;           // ms to wait for the server to take a frame
const TOKEN_KEY = 'thermalRemote.phone';

const state = {
  code: '',
  ws: null,
  wsOpen: false,
  hostConnected: false,
  phoneToken: null,
  retry: 0,
  closedForGood: false,
  clock: { offset: 0, samples: [] }, // server_ms - Date.now()
  stream: null,
  facing: 'environment',
  deviceId: null,
  busy: null,         // { captureId, kind } while capturing / uploading
  recorder: null,
  frameInFlight: false,
  frameSentAt: 0,
  lastFrameAt: 0,
  wakeLock: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverNow = () => Date.now() + state.clock.offset;

// ---------- UI ----------

function setStatus(text, isError = false) {
  $('statusLine').textContent = text;
  $('statusLine').classList.toggle('is-error', isError);
}

function setPill(text, kind) {
  const pill = $('linkPill');
  pill.textContent = text;
  pill.className = `rc-pill${kind ? ` is-${kind}` : ''}`;
}

function render() {
  const live = Boolean(state.stream);
  $('stageEmpty').hidden = live;
  $('flipBtn').disabled = !live || Boolean(state.busy);
  $('cameraSelect').disabled = Boolean(state.busy);
  stage.classList.toggle('is-mirrored', live && state.facing === 'user');
  if (state.busy) return;
  if (!state.wsOpen) {
    setPill('offline', 'warn');
  } else if (!state.hostConnected) {
    setPill('paired', 'warn');
    setStatus(live ? 'Paired. Waiting for the laptop page to reconnect…' : 'Paired. Start the camera.');
  } else {
    setPill(live ? 'ready' : 'linked', live ? 'on' : 'warn');
    setStatus(live ? 'Ready. The laptop will start the capture.' : 'Connected to the laptop. Start the camera.');
  }
}

function phoneModel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m && m[1] && m[1] !== 'K') return m[1].trim().slice(0, 40);
  if (/Android/.test(ua)) return 'Android phone';
  return 'Mobile browser';
}

function sendStatus() {
  const track = state.stream && state.stream.getVideoTracks()[0];
  const settings = track ? track.getSettings() : {};
  send({
    type: 'status',
    model: phoneModel(),
    camera: track ? (track.label || (state.facing === 'user' ? 'Front camera' : 'Back camera')).slice(0, 40) : '',
    facing: settings.facingMode || state.facing,
    camera_on: Boolean(track && track.readyState === 'live'),
    width: video.videoWidth || settings.width || 0,
    height: video.videoHeight || settings.height || 0,
    visible: document.visibilityState === 'visible',
  });
}

// ---------- WebSocket ----------

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function loadToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    return saved && saved.code === state.code ? saved.token : null;
  } catch { return null; }
}

function connect() {
  if (state.closedForGood) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ role: 'phone', code: state.code });
  const token = state.phoneToken || loadToken();
  if (token) params.set('token', token);
  const ws = new WebSocket(`${proto}//${location.host}/thermal/remote/ws?${params}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  ws.onopen = () => { state.retry = 0; };
  ws.onmessage = (e) => { if (typeof e.data === 'string') onMessage(JSON.parse(e.data)); };
  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    state.wsOpen = false;
    state.hostConnected = false;
    state.frameInFlight = false;
    if (e.code === 4404 || e.code === 4410) {
      state.closedForGood = true;
      showJoin(e.code === 4404 ? 'That code was not found or has expired. Check the code on the laptop.' : 'The laptop ended the pairing. Scan the new code.');
      return;
    }
    if (e.code === 4002) {
      state.closedForGood = true;
      setPill('replaced', 'warn');
      setStatus('Another phone paired with the laptop. Scan the code again to use this phone.', true);
      return;
    }
    if (e.code === 4429) {
      state.closedForGood = true;
      showJoin('Too many wrong codes. Wait a few minutes and try again.');
      return;
    }
    render();
    setStatus('Connection lost. Reconnecting…', true);
    const wait = Math.min(10000, 500 * 2 ** state.retry++);
    setTimeout(connect, wait);
  };
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      state.wsOpen = true;
      state.phoneToken = msg.phone_token;
      state.hostConnected = Boolean(msg.host_connected);
      try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ code: state.code, token: msg.phone_token })); } catch { /* ignore */ }
      history.replaceState(null, '', `?c=${encodeURIComponent(state.code)}`);
      syncClock(8);
      sendStatus();
      render();
      break;
    case 'pong': onPong(msg); break;
    case 'host':
      state.hostConnected = Boolean(msg.connected);
      if (state.hostConnected) sendStatus();
      render();
      break;
    case 'frame_ack':
      state.frameInFlight = false;
      break;
    case 'capture': onCapture(msg); break;
    case 'cancel': onCancel(msg); break;
    case 'replaced':
    case 'session_closed':
      break; // the close code that follows says what to do
    default:
      break;
  }
}

// ---------- clock sync (NTP-style, keep the lowest-latency samples) ----------

async function syncClock(n) {
  for (let i = 0; i < n; i += 1) {
    send({ type: 'ping', t0: Date.now() });
    await sleep(120);
  }
}

function onPong(msg) {
  const t1 = Date.now();
  const rtt = t1 - msg.t0;
  if (!(rtt >= 0 && rtt < 5000)) return;
  const s = state.clock.samples;
  s.push({ rtt, offset: msg.ts - (msg.t0 + t1) / 2, at: t1 });
  while (s.length > 20) s.shift();
  const best = [...s].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
  state.clock.offset = best.reduce((acc, x) => acc + x.offset, 0) / best.length;
}

setInterval(() => { if (state.wsOpen) send({ type: 'ping', t0: Date.now() }); }, 10000);

// ---------- camera ----------

function describeCameraError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site in the browser settings, then reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it and try again.';
    default:
      return `Could not start the camera${err && err.message ? `: ${err.message}` : '.'}`;
  }
}

async function startCamera({ deviceId, facing } = {}) {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const constraints = deviceId
    ? { deviceId: { exact: deviceId }, ...size }
    : { facingMode: { ideal: facing || state.facing }, ...size };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
  state.stream = stream;
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  state.deviceId = settings.deviceId || deviceId || null;
  if (settings.facingMode) state.facing = settings.facingMode;
  else if (facing) state.facing = facing;
  track.addEventListener('ended', () => {
    state.stream = null;
    sendStatus();
    render();
    setStatus('The camera stopped. Tap Start camera.', true);
  });
  $('camLabel').textContent = track.label || (state.facing === 'user' ? 'Front camera' : 'Back camera');
  $('camLabel').hidden = false;
  await listCameras();
  keepAwake();
  video.addEventListener('loadedmetadata', sendStatus, { once: true });
  sendStatus();
  render();
}

async function listCameras() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const select = $('cameraSelect');
  select.innerHTML = '';
  cams.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
    if (cam.deviceId === state.deviceId) opt.selected = true;
    select.appendChild(opt);
  });
  select.hidden = cams.length < 3; // front/back covers two cameras
}

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  try {
    await startCamera();
  } catch (err) {
    $('stageEmptyText').textContent = describeCameraError(err);
  } finally {
    $('startBtn').disabled = false;
  }
});

$('flipBtn').addEventListener('click', async () => {
  try { await startCamera({ facing: state.facing === 'user' ? 'environment' : 'user' }); } catch (err) { setStatus(describeCameraError(err), true); }
});

$('cameraSelect').addEventListener('change', async () => {
  try { await startCamera({ deviceId: $('cameraSelect').value }); } catch (err) { setStatus(describeCameraError(err), true); }
});

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock && document.visibilityState === 'visible') {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch { /* not supported or refused; the help text asks to keep the screen on */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    if (state.stream && state.stream.getVideoTracks()[0].readyState !== 'live') {
      state.stream = null;
      render();
      setStatus('The camera stopped while the page was in the background. Tap Start camera.', true);
    }
  }
  sendStatus();
});

// ---------- preview frames for the laptop ----------

async function previewLoop() {
  const canvas = $('frameCanvas');
  const ctx = canvas.getContext('2d');
  for (;;) {
    await sleep(40);
    const now = performance.now();
    if (state.frameInFlight && now - state.frameSentAt > ACK_TIMEOUT) state.frameInFlight = false;
    if (!state.wsOpen || !state.hostConnected || !state.stream || state.frameInFlight || document.hidden) continue;
    if (state.busy && state.busy.kind === 'video') continue; // keep the phone's CPU for the recording
    if (now - state.lastFrameAt < PREVIEW_MIN_INTERVAL || !video.videoWidth) continue;
    const scale = Math.min(1, PREVIEW_WIDTH / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.6));
    if (!blob || !state.ws || state.ws.readyState !== WebSocket.OPEN) continue;
    state.frameInFlight = true;
    state.frameSentAt = performance.now();
    state.lastFrameAt = state.frameSentAt;
    state.ws.send(await blob.arrayBuffer());
  }
}

// ---------- capture (started by the laptop) ----------

async function waitUntil(serverMs) {
  for (;;) {
    const left = serverMs - serverNow();
    if (left <= 0) return;
    await sleep(left > 30 ? left - 20 : Math.max(1, left / 2));
  }
}

function pickRecorderType() {
  // iPhone records MP4 (H.264); Android Chrome records WebM.
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function fail(captureId, message) {
  send({ type: 'error', capture_id: captureId, message });
  setStatus(message, true);
}

async function onCapture(msg) {
  const captureId = String(msg.capture_id || '');
  if (state.busy) { fail(captureId, 'The phone is still busy with the previous capture.'); return; }
  if (!state.stream || !video.videoWidth) { fail(captureId, 'The phone camera is not on. Tap Start camera on the phone.'); return; }
  const kind = msg.mode === 'video' ? 'video' : 'photo';
  state.busy = { captureId, kind, cancelled: false };
  render();
  try {
    const result = kind === 'video'
      ? await recordVideo(captureId, Number(msg.duration) || 5, Number(msg.at_ms) || serverNow())
      : await takePhoto(captureId, Number(msg.at_ms) || serverNow());
    if (!state.busy || state.busy.cancelled) return;
    await uploadFile(captureId, kind, result);
    setStatus(kind === 'video' ? 'Video sent to the laptop.' : 'Photo sent to the laptop.');
    setPill('sent', 'on');
    await sleep(1200);
  } catch (err) {
    if (!(state.busy && state.busy.cancelled)) fail(captureId, `Capture failed: ${err.message || err}`);
  } finally {
    state.busy = null;
    $('uploadBar').hidden = true;
    render();
  }
}

async function takePhoto(captureId, atMs) {
  setStatus('Taking the photo…');
  await waitUntil(atMs);
  const startedMs = serverNow();
  const canvas = $('photoCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  $('flash').classList.remove('is-on');
  void $('flash').offsetWidth;
  $('flash').classList.add('is-on');
  send({ type: 'captured', capture_id: captureId, kind: 'photo', started_ms: startedMs });
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('could not encode the photo');
  return { blob, filename: 'phone.jpg', startedMs, endedMs: startedMs };
}

function showRec(seconds) {
  $('recBadge').hidden = false;
  stage.classList.add('is-recording');
  const bar = $('recProgress');
  bar.hidden = false;
  bar.style.setProperty('--rec-duration', `${seconds}s`);
  bar.classList.remove('is-running');
  void bar.offsetWidth;
  bar.classList.add('is-running');
  setPill('rec', 'rec');
  const t0 = performance.now();
  const tick = () => {
    const left = Math.max(0, seconds - (performance.now() - t0) / 1000);
    $('recText').textContent = `REC ${left.toFixed(1)} s`;
    setStatus(`Recording… ${left.toFixed(1)} s left. Hold still.`);
  };
  tick();
  return setInterval(tick, 100);
}

function hideRec(timer) {
  clearInterval(timer);
  $('recBadge').hidden = true;
  $('recProgress').hidden = true;
  stage.classList.remove('is-recording');
}

async function recordVideo(captureId, seconds, atMs) {
  const mimeType = pickRecorderType();
  if (!mimeType) throw new Error('this browser cannot record video');
  const recorder = new MediaRecorder(state.stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  state.recorder = recorder;
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const started = new Promise((resolve) => { recorder.onstart = () => resolve(serverNow()); });
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(serverNow());
    recorder.onerror = (e) => reject(e.error || new Error('recording failed'));
  });
  setStatus('Get ready…');
  await waitUntil(atMs);
  recorder.start(500);
  const startedMs = await started;
  send({ type: 'recording', capture_id: captureId, started_ms: startedMs, duration: seconds });
  const timer = showRec(seconds);
  const stopAt = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, seconds * 1000);
  let endedMs;
  try {
    endedMs = await stopped;
  } finally {
    clearTimeout(stopAt);
    hideRec(timer);
    state.recorder = null;
  }
  if (state.busy && state.busy.cancelled) throw new Error('cancelled');
  const type = mimeType.split(';')[0];
  const blob = new Blob(chunks, { type });
  if (!blob.size) throw new Error('the recording came out empty');
  send({ type: 'captured', capture_id: captureId, kind: 'video', started_ms: startedMs, ended_ms: endedMs });
  return { blob, filename: type === 'video/mp4' ? 'phone.mp4' : 'phone.webm', startedMs, endedMs };
}

function uploadOnce(captureId, kind, result) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('phone_token', state.phoneToken || '');
    fd.append('capture_id', captureId);
    fd.append('kind', kind);
    fd.append('started_ms', String(result.startedMs));
    fd.append('ended_ms', String(result.endedMs));
    fd.append('file', result.blob, result.filename);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/thermal/remote/upload');
    let lastSent = 0;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total;
      $('uploadBar').firstElementChild.style.width = `${Math.round(p * 100)}%`;
      setStatus(`Sending to the laptop… ${Math.round(p * 100)}%`);
      if (performance.now() - lastSent > 300 || p === 1) {
        lastSent = performance.now();
        send({ type: 'upload_progress', capture_id: captureId, loaded: e.loaded, total: e.total });
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        let detail = `server responded ${xhr.status}`;
        try { detail = JSON.parse(xhr.responseText).detail || detail; } catch { /* not JSON */ }
        const err = new Error(detail);
        err.fatal = xhr.status >= 400 && xhr.status < 500;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(fd);
  });
}

async function uploadFile(captureId, kind, result) {
  $('uploadBar').hidden = false;
  $('uploadBar').firstElementChild.style.width = '0';
  setPill('sending', 'warn');
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await uploadOnce(captureId, kind, result);
    } catch (err) {
      if (err.fatal || attempt >= 3 || (state.busy && state.busy.cancelled)) throw err;
      setStatus(`Upload failed (${err.message}). Retrying…`, true);
      await sleep(1500 * attempt);
    }
  }
}

function onCancel(msg) {
  if (!state.busy || (msg.capture_id && msg.capture_id !== state.busy.captureId)) return;
  state.busy.cancelled = true;
  if (state.recorder && state.recorder.state === 'recording') state.recorder.stop();
  setStatus('Capture cancelled on the laptop.');
}

// ---------- join ----------

function normalizeCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function showJoin(error) {
  $('joinPanel').hidden = false;
  $('cameraPanel').hidden = true;
  $('joinError').hidden = !error;
  $('joinError').textContent = error || '';
  setPill('not paired', 'warn');
  if (state.code) $('codeInput').value = state.code;
}

function join(code) {
  state.code = code;
  state.closedForGood = false;
  state.retry = 0;
  $('joinPanel').hidden = true;
  $('cameraPanel').hidden = false;
  setStatus('Connecting to the laptop…');
  connect();
  render();
}

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normalizeCode($('codeInput').value);
  if (code.length !== 6) {
    $('joinError').hidden = false;
    $('joinError').textContent = 'The code has 6 letters and numbers.';
    return;
  }
  join(code);
});

(function init() {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    showJoin('This page needs a secure https:// connection and a browser with camera support.');
    return;
  }
  const code = normalizeCode(new URLSearchParams(location.search).get('c'));
  if (code.length === 6) join(code);
  else showJoin('');
  previewLoop();
})();
