const $ = (id) => document.getElementById(id);

// Same emotion colors as the capture app, so a hue means the same thing on both pages.
const EMOTIONS = {
  Happiness: '#e2a400',
  Neutral: '#7a8699',
  Sadness: '#3b82f6',
  Anger: '#e5484d',
  Fear: '#8e5cd9',
  Surprise: '#e0559b',
  Disgust: '#3f9b4e',
  Contempt: '#c46a2b',
  Unknown: '#b4bac4',
};
const EMOTION_ORDER = Object.keys(EMOTIONS);
const EXCLUDED_KEY = 'emotionAdmin.excluded';

// Why a capture produced no result, read from the message the server stored with it. First match wins.
const REJECT_REASONS = [
  {
    key: 'no_face', label: 'No face detected', short: 'No face', color: '#e2a400', match: /no face was detected/i,
    hint: 'The face detector found no face it was at least 90% sure of, in the photo or in any sampled video frame. Usual causes: dim or back light, face too far away or turned aside, or partly covered.',
  },
  {
    key: 'unreadable', label: 'Unreadable file', short: 'Unreadable', color: '#e5484d', match: /could not be (read|opened)/i,
    hint: 'The uploaded photo or video could not be decoded, usually because the upload was empty or cut short, or the video format is not supported.',
  },
  {
    key: 'no_scores', label: 'No valid scores', short: 'No scores', color: '#8e5cd9', match: /no valid scores/i,
    hint: 'A face was found, but the emotion model returned no usable scores for it.',
  },
  {
    key: 'error', label: 'Analysis error', short: 'Error', color: '#c46a2b', match: /inference failed/i,
    hint: 'The analysis crashed. The message holds the technical error; the server log (journalctl -u emotion-api) has the full trace.',
  },
  { key: 'other', label: 'Other', short: 'Other', color: '#7a8699', match: /[\s\S]*/, hint: 'Not a known reason. See the stored message.' },
];
const REASON_BY_KEY = Object.fromEntries(REJECT_REASONS.map((r) => [r.key, r]));
const SVG_NS = 'http://www.w3.org/2000/svg';
const LEGACY_NAME = 'Unregistered (legacy)';

const state = {
  subjects: [],
  captures: [],
  excluded: new Set(JSON.parse(localStorage.getItem(EXCLUDED_KEY) || '[]')),
  tab: 'overview',
  hiddenMood: new Set(),
  hiddenExplorer: new Set(),
  sort: {
    captures: { key: 'created_at', dir: -1 },
    participants: { key: 'last', dir: -1 },
    rejected: { key: 'created_at', dir: -1 },
  },
  detail: null,
};

// ---------- Formatting ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmtSigned = (v, d = 2) => (isNum(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '—');
const fmtPct = (v, d = 0) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : '—');
const fmtNum = (v, d = 2) => (isNum(v) ? v.toFixed(d) : '—');
const fmtP = (p) => (!isNum(p) ? '—' : p < 0.001 ? '< 0.001' : p.toFixed(3));

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shortId(id) {
  return id ? `${id.slice(0, 10)}…` : '—';
}

function emotionColor(name) {
  return EMOTIONS[name] || EMOTIONS.Unknown;
}

function emoChip(name) {
  return `<span class="emo-chip" style="--chip:${emotionColor(name)}">${esc(name || 'Unknown')}</span>`;
}

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

const hasFace = (c) => isNum(c.valence) && isNum(c.arousal);
const mediaLabel = (t) => (t === 'video' ? 'Video' : 'Photo');

// ---------- Statistics ----------

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function variance(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

function sd(xs) {
  return Math.sqrt(variance(xs));
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function logGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betaCf(a, b, x) {
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a, b).
function incBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betaCf(a, b, x)) / a : 1 - (bt * betaCf(b, a, 1 - x)) / b;
}

// Two-sided p-value for Student's t.
function tPValue(t, df) {
  return incBeta(df / (df + t * t), df / 2, 0.5);
}

function fPValue(f, d1, d2) {
  return incBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

// Critical t for a two-sided 95% interval, by bisection on the p-value.
function tCrit95(df) {
  if (!(df >= 1)) return NaN;
  let lo = 0;
  let hi = 700;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tPValue(mid, df) > 0.05) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function describe(xs) {
  const n = xs.length;
  const m = mean(xs);
  const s = sd(xs);
  const half = n >= 2 ? tCrit95(n - 1) * (s / Math.sqrt(n)) : NaN;
  return { n, mean: m, sd: s, median: median(xs), min: Math.min(...xs), max: Math.max(...xs), lo: m - half, hi: m + half };
}

function welch(a, b) {
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const pooled = Math.sqrt(((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) / (a.length + b.length - 2));
  return { t, df, p: tPValue(t, df), d: (mean(a) - mean(b)) / pooled };
}

function anova(groups) {
  const all = groups.flat();
  const grand = mean(all);
  const k = groups.length;
  const n = all.length;
  const ssb = groups.reduce((acc, g) => acc + g.length * (mean(g) - grand) ** 2, 0);
  const ssw = groups.reduce((acc, g) => acc + g.reduce((a, x) => a + (x - mean(g)) ** 2, 0), 0);
  const d1 = k - 1;
  const d2 = n - k;
  const f = ssb / d1 / (ssw / d2);
  return { f, d1, d2, p: fPValue(f, d1, d2), eta2: ssb / (ssb + ssw) };
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return { r, n, p: n > 2 && Math.abs(r) < 1 ? tPValue(t, n - 2) : NaN, slope: sxy / sxx, intercept: my - (sxy / sxx) * mx };
}

// ---------- Data loading ----------

// 'pending' (blind capture not analyzed yet), 'rejected' (no result) or 'ok', plus the rejection reason.
function captureOutcome(c) {
  if (c.analysis_status === 'pending') return { outcome: 'pending', reason: null };
  if (c.emotion && c.emotion !== 'Unknown') return { outcome: 'ok', reason: null };
  const message = c.message || '';
  return { outcome: 'rejected', reason: REJECT_REASONS.find((r) => r.match.test(message)).key };
}

function outcomeChip(c) {
  if (c.outcome === 'pending') return '<span class="emo-chip">Analyzing…</span>';
  if (c.outcome === 'rejected') {
    const r = REASON_BY_KEY[c.reason];
    return `<span class="emo-chip" style="--chip:${r.color}">Rejected · ${esc(r.label)}</span>`;
  }
  return emoChip(c.emotion);
}

const modeLabel = (m) => (m === 'blind' ? 'Blind (/collect)' : 'Interactive');

async function load() {
  $('loadedAt').textContent = 'Loading…';
  try {
    const response = await fetch('/admin/data', { cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Request failed (${response.status})`);
    }
    const data = await response.json();
    state.subjects = data.subjects;
    state.captures = data.captures.map((c) => ({
      ...c,
      // Captures recorded before participant details were collected have no subject.
      subject_id: c.subject_id || '',
      name: c.name || LEGACY_NAME,
      emotion: c.emotion || 'Unknown',
      ...captureOutcome(c),
      time: new Date(c.created_at),
      frameCount: c.frames.length,
      valenceSd: c.media_type === 'video' ? sd(c.frames.map((f) => f.valence).filter(isNum)) : NaN,
      arousalSd: c.media_type === 'video' ? sd(c.frames.map((f) => f.arousal).filter(isNum)) : NaN,
    }));
    $('loadedAt').textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    populateEmotionFilter();
    render();
  } catch (err) {
    $('loadedAt').textContent = '';
    $('kpis').innerHTML = `<div class="kpi"><span class="kpi-label">Could not load data</span><span class="kpi-note">${esc(err.message)}</span></div>`;
  }
}

function populateEmotionFilter() {
  const select = $('fEmotion');
  const current = select.value;
  const present = new Set(state.captures.map((c) => c.emotion));
  select.innerHTML = '<option value="">All</option>' +
    EMOTION_ORDER.filter((e) => present.has(e)).map((e) => `<option>${esc(e)}</option>`).join('');
  select.value = present.has(current) ? current : '';
}

// ---------- Filtering ----------

// ---------- Date/time range ----------

const pad2 = (n) => String(n).padStart(2, '0');
const toDateValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toTimeValue = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const RANGE_IDS = ['fFromDate', 'fFromTime', 'fToDate', 'fToTime'];

// Both bounds are inclusive and in the browser's local time. The time is optional:
// an empty From time means 00:00, an empty To time means the end of that day.
// "To" covers the whole selected minute, so To 12:00 keeps a capture at 12:00:40.
function readRange() {
  const fromDate = $('fFromDate').value;
  const toDate = $('fToDate').value;
  const from = fromDate ? new Date(`${fromDate}T${$('fFromTime').value || '00:00'}:00`) : null;
  const to = toDate ? new Date(`${toDate}T${$('fToTime').value || '23:59'}:59.999`) : null;
  // Chrome reports a value while the year is still being typed ("0002-11-04"), so ignore implausible years.
  const ok = (d) => d && !isNaN(d) && d.getFullYear() >= 2000;
  return { from: ok(from) ? from : null, to: ok(to) ? to : null };
}

function setRange(from, to, { fromTime = false, toTime = false } = {}) {
  $('fFromDate').value = from ? toDateValue(from) : '';
  $('fFromTime').value = from && fromTime ? toTimeValue(from) : '';
  $('fToDate').value = to ? toDateValue(to) : '';
  $('fToTime').value = to && toTime ? toTimeValue(to) : '';
}

function applyPreset(key) {
  const now = new Date();
  if (key === 'today') setRange(now, now);
  if (key === '24h') setRange(new Date(now - 864e5), null, { fromTime: true });
  if (key === '7d') setRange(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6), null);
  if (key === 'all') setRange(null, null);
  markPreset(key === 'all' ? null : key);
  render();
}

function markPreset(key) {
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === key)));
}

function fmtWhen(d) {
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
}

function localZoneName() {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
  return part ? part.value : 'local time';
}

// Spells out the range actually applied, and flags input that can't match anything.
function renderRangeNote(count) {
  const note = $('rangeNote');
  const { from, to } = readRange();
  const timeOnly = (!$('fFromDate').value && $('fFromTime').value) || (!$('fToDate').value && $('fToTime').value);
  const reversed = from && to && from > to;
  $('fFromDate').classList.toggle('is-invalid', Boolean(reversed));
  $('fToDate').classList.toggle('is-invalid', Boolean(reversed));
  let text;
  if (reversed) text = '“From” is after “To”, so no captures can match. Swap the dates or pick a later “To”.';
  else if (timeOnly) text = 'A time only applies once you also pick its date.';
  note.classList.toggle('warn', Boolean(reversed || timeOnly));
  if (!text) {
    const zone = `times in ${localZoneName()}`;
    const n = `${count} capture${count === 1 ? '' : 's'}`;
    if (from && to) text = `Showing ${n} from ${fmtWhen(from)} to ${fmtWhen(to)} · ${zone}`;
    else if (from) text = `Showing ${n} since ${fmtWhen(from)} · ${zone}`;
    else if (to) text = `Showing ${n} up to ${fmtWhen(to)} · ${zone}`;
    else text = `All dates · ${n} · leave the time empty to cover the whole day`;
  }
  note.textContent = text;
}

function readFilters() {
  const { from, to } = readRange();
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  return {
    from,
    to,
    media: $('fMedia').value,
    diet: $('fDiet').value,
    ageMin: num('fAgeMin'),
    ageMax: num('fAgeMax'),
    emotion: $('fEmotion').value,
    minConf: num('fMinConf'),
    search: $('fSearch').value.trim().toLowerCase(),
    faceOnly: $('fFaceOnly').checked,
    showExcluded: $('fShowExcluded').checked,
  };
}

// resultFilters: false skips the filters that only make sense for captures with a result.
function filtered({ resultFilters = true } = {}) {
  const f = readFilters();
  if (!resultFilters) Object.assign(f, { emotion: '', minConf: null, faceOnly: false });
  return state.captures.filter((c) => {
    if (!f.showExcluded && state.excluded.has(c.capture_id)) return false;
    if (f.from && c.time < f.from) return false;
    if (f.to && c.time > f.to) return false;
    if (f.media && c.media_type !== f.media) return false;
    if (f.diet && c.diet !== f.diet) return false;
    if (f.ageMin !== null && !(c.age >= f.ageMin)) return false;
    if (f.ageMax !== null && !(c.age <= f.ageMax)) return false;
    if (f.emotion && c.emotion !== f.emotion) return false;
    if (f.minConf !== null && !(c.confidence * 100 >= f.minConf)) return false;
    if (f.faceOnly && !hasFace(c)) return false;
    if (f.search && !`${c.name} ${c.subject_id}`.toLowerCase().includes(f.search)) return false;
    return true;
  });
}

// ---------- Tooltip ----------

const tooltip = $('tooltip');

function tipHtml(title, rows) {
  return `<div class="tt-title">${title}</div>` +
    rows.map(([k, v]) => `<div class="tt-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
}

function showTip(event, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pad = 14;
  const { innerWidth, innerHeight } = window;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > innerHeight - 8) y = event.clientY - rect.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function hideTip() {
  tooltip.hidden = true;
}

function bindTip(node, html, onClick) {
  node.addEventListener('mousemove', (e) => showTip(e, typeof html === 'function' ? html() : html));
  node.addEventListener('mouseleave', hideTip);
  if (onClick) {
    node.addEventListener('click', () => {
      hideTip();
      onClick();
    });
  }
}

// ---------- SVG helpers ----------

function el(tag, attrs = {}, parent = null, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function makeSvg(container, width, height, label) {
  container.innerHTML = '';
  return el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label }, container);
}

function emptyChart(container, text = 'Not enough data for this chart.') {
  container.innerHTML = `<p class="chart-empty">${esc(text)}</p>`;
}

function chartWidth(container) {
  return Math.max(280, container.clientWidth || 600);
}

function scale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

function niceTicks(min, max, count = 5) {
  if (!isNum(min) || !isNum(max)) return [];
  if (min === max) return [min];
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function niceDomain(values, pad = 0.05) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return [lo - 1, hi + 1];
  const p = (hi - lo) * pad;
  const ticks = niceTicks(lo - p, hi + p);
  return [Math.min(lo - p, ticks[0]), Math.max(hi + p, ticks[ticks.length - 1])];
}

// Path for a horizontal bar with a 4px rounded data-end and a square baseline.
function hBarPath(x0, y, w, h, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, w, h / 2);
  return `M${x0},${y}H${x0 + w - rr}Q${x0 + w},${y} ${x0 + w},${y + rr}V${y + h - rr}Q${x0 + w},${y + h} ${x0 + w - rr},${y + h}H${x0}Z`;
}

function vBarPath(x, y0, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y0}V${y0 - h + rr}Q${x},${y0 - h} ${x + rr},${y0 - h}H${x + w - rr}Q${x + w},${y0 - h} ${x + w},${y0 - h + rr}V${y0}Z`;
}

// ---------- Chart: horizontal bars ----------

function barChart(container, rows, { format = String, label = 'Bar chart' } = {}) {
  if (!rows.length) return emptyChart(container);
  const width = chartWidth(container);
  const labelW = 96;
  const valueW = 70;
  const rowH = 32;
  const barH = 20;
  const height = rows.length * rowH + 4;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const x = scale(0, max, labelW, width - valueW);
  const svg = makeSvg(container, width, height, label);
  el('line', { x1: labelW, x2: labelW, y1: 0, y2: height, class: 'axis' }, svg);
  rows.forEach((row, i) => {
    const y = i * rowH + (rowH - barH) / 2;
    el('text', { x: labelW - 10, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'cat-label' }, svg, row.label);
    el('path', { d: hBarPath(labelW, y, x(row.value) - labelW, barH), fill: row.color, class: 'bar' }, svg);
    el('text', { x: x(row.value) + 6, y: y + barH / 2 + 4, class: 'bar-label' }, svg, format(row));
    const hit = el('rect', { x: 0, y: i * rowH, width, height: rowH, class: 'hit' }, svg);
    if (row.tip) bindTip(hit, row.tip, row.onClick);
  });
}

// ---------- Chart: scatter ----------

function scatterChart(container, opts) {
  const { points, xDomain, yDomain, xLabel, yLabel, square = false, quadrants = false, fit = null, xFormat = (v) => fmtNum(v, 1), yFormat = (v) => fmtNum(v, 1), xTicks = null } = opts;
  if (!points.length) return emptyChart(container, 'No data points for this selection.');
  const width = chartWidth(container);
  const m = { top: 14, right: 16, bottom: 44, left: 52 };
  const height = square ? Math.min(width, 520) : 420;
  const x = scale(xDomain[0], xDomain[1], m.left, width - m.right);
  const y = scale(yDomain[0], yDomain[1], height - m.bottom, m.top);
  const svg = makeSvg(container, width, height, opts.label || 'Scatter plot');

  for (const t of niceTicks(...yDomain)) {
    el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'grid' }, svg);
    el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, yFormat(t));
  }
  for (const t of xTicks || niceTicks(...xDomain)) {
    el('line', { x1: x(t), x2: x(t), y1: m.top, y2: height - m.bottom, class: 'grid' }, svg);
    el('text', { x: x(t), y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, xFormat(t));
  }
  if (quadrants) {
    el('line', { x1: x(0), x2: x(0), y1: m.top, y2: height - m.bottom, class: 'axis' }, svg);
    el('line', { x1: m.left, x2: width - m.right, y1: y(0), y2: y(0), class: 'axis' }, svg);
    const q = [
      ['Pleasant · energized', width - m.right - 6, m.top + 14, 'end'],
      ['Unpleasant · energized', m.left + 6, m.top + 14, 'start'],
      ['Unpleasant · calm', m.left + 6, height - m.bottom - 8, 'start'],
      ['Pleasant · calm', width - m.right - 6, height - m.bottom - 8, 'end'],
    ];
    for (const [text, qx, qy, anchor] of q) el('text', { x: qx, y: qy, 'text-anchor': anchor, class: 'quad-label' }, svg, text);
  } else {
    el('line', { x1: m.left, x2: width - m.right, y1: height - m.bottom, y2: height - m.bottom, class: 'axis' }, svg);
  }
  el('text', { x: (m.left + width - m.right) / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-title' }, svg, xLabel);
  el('text', { x: 12, y: (m.top + height - m.bottom) / 2, 'text-anchor': 'middle', class: 'axis-title', transform: `rotate(-90 12 ${(m.top + height - m.bottom) / 2})` }, svg, yLabel);

  if (fit) {
    const [x0, x1] = xDomain;
    el('line', { x1: x(x0), y1: y(fit.intercept + fit.slope * x0), x2: x(x1), y2: y(fit.intercept + fit.slope * x1), class: 'fit' }, svg);
  }

  const clip = el('clipPath', { id: `clip-${container.id}` }, el('defs', {}, svg));
  el('rect', { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom }, clip);
  if (fit) svg.querySelector('.fit').setAttribute('clip-path', `url(#clip-${container.id})`);

  for (const p of points) {
    const dot = marker(svg, p.shape, x(p.x), y(p.y), p.r || 5.5, { fill: p.color, class: 'dot', ...(p.opacity ? { 'fill-opacity': p.opacity } : {}) });
    if (p.tip) bindTip(dot, p.tip, p.onClick);
  }
  return { svg, x, y, m, width, height };
}

// A circle, or a diamond of similar visual weight, so two groups differ by shape as well as color.
function marker(svg, shape, cx, cy, r, attrs) {
  if (shape !== 'diamond') return el('circle', { cx, cy, r, ...attrs }, svg);
  const d = r * 1.3;
  return el('path', { d: `M${cx},${cy - d}L${cx + d},${cy}L${cx},${cy + d}L${cx - d},${cy}Z`, ...attrs }, svg);
}

// ---------- Chart: columns over time ----------

function columnChart(container, bins, { label = 'Column chart', yLabel = '' } = {}) {
  if (!bins.length) return emptyChart(container);
  const width = chartWidth(container);
  const m = { top: 18, right: 12, bottom: 34, left: 40 };
  const height = 220;
  const max = Math.max(...bins.map((b) => b.value), 1);
  const ticks = niceTicks(0, max, 4).filter((t) => Number.isInteger(t));
  const top = Math.max(max, ticks[ticks.length - 1] || max);
  const y = scale(0, top, height - m.bottom, m.top);
  const slot = (width - m.left - m.right) / bins.length;
  const barW = Math.max(2, Math.min(24, slot - 2));
  const svg = makeSvg(container, width, height, label);
  for (const t of ticks) {
    el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'grid' }, svg);
    el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, String(t));
  }
  if (yLabel) el('text', { x: 4, y: m.top - 6, class: 'axis-title' }, svg, yLabel);
  el('line', { x1: m.left, x2: width - m.right, y1: y(0), y2: y(0), class: 'axis' }, svg);
  const labelEvery = Math.ceil(bins.length / Math.max(1, Math.floor((width - m.left) / 64)));
  bins.forEach((b, i) => {
    const cx = m.left + slot * i + slot / 2;
    el('path', { d: vBarPath(cx - barW / 2, y(0), barW, y(0) - y(b.value)), fill: cssVar('--series-1'), class: 'bar' }, svg);
    if (i % labelEvery === 0) el('text', { x: cx, y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, b.label);
    const hit = el('rect', { x: m.left + slot * i, y: m.top, width: slot, height: height - m.top - m.bottom, class: 'hit' }, svg);
    bindTip(hit, b.tip);
  });
}

// ---------- Chart: mean ± 95% CI per group ----------

function ciChart(container, groups, { domain, metricLabel, format }) {
  if (!groups.length) return emptyChart(container);
  const width = chartWidth(container);
  const labelW = Math.min(180, Math.max(90, ...groups.map((g) => g.label.length * 7 + 16)));
  const m = { top: 8, right: 70, bottom: 36 };
  const rowH = 34;
  const height = groups.length * rowH + m.top + m.bottom;
  const x = scale(domain[0], domain[1], labelW, width - m.right);
  const svg = makeSvg(container, width, height, `${metricLabel} by group`);
  const plotBottom = height - m.bottom;
  for (const t of niceTicks(...domain)) {
    el('line', { x1: x(t), x2: x(t), y1: m.top, y2: plotBottom, class: t === 0 ? 'axis' : 'grid' }, svg);
    el('text', { x: x(t), y: plotBottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, format(t));
  }
  el('text', { x: (labelW + width - m.right) / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-title' }, svg, `Mean ${metricLabel.toLowerCase()} (95% CI)`);
  groups.forEach((g, i) => {
    const cy = m.top + i * rowH + rowH / 2;
    el('text', { x: labelW - 10, y: cy + 4, 'text-anchor': 'end', class: 'cat-label' }, svg, g.label);
    if (isNum(g.lo) && isNum(g.hi)) {
      el('line', { x1: x(Math.max(domain[0], g.lo)), x2: x(Math.min(domain[1], g.hi)), y1: cy, y2: cy, class: 'ci' }, svg);
    }
    el('circle', { cx: x(g.mean), cy, r: 6, fill: cssVar('--series-1'), class: 'dot' }, svg);
    el('text', { x: width - m.right + 8, y: cy + 4, class: 'bar-label' }, svg, `n=${g.n}`);
    const hit = el('rect', { x: 0, y: cy - rowH / 2, width, height: rowH, class: 'hit' }, svg);
    bindTip(hit, g.tip);
  });
}

// ---------- Chart: 100% stacked bars ----------

function stackedChart(container, groups) {
  if (!groups.length) return emptyChart(container);
  const width = chartWidth(container);
  const labelW = Math.min(180, Math.max(90, ...groups.map((g) => g.label.length * 7 + 16)));
  const valueW = 52;
  const rowH = 34;
  const barH = 22;
  const height = groups.length * rowH + 4;
  const x = scale(0, 1, labelW, width - valueW);
  const svg = makeSvg(container, width, height, 'Emotion share by group');
  groups.forEach((g, i) => {
    const y = i * rowH + (rowH - barH) / 2;
    el('text', { x: labelW - 10, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'cat-label' }, svg, g.label);
    el('text', { x: width - valueW + 8, y: y + barH / 2 + 4, class: 'bar-label' }, svg, `n=${g.n}`);
    let acc = 0;
    const segs = g.segments.filter((s) => s.value > 0);
    segs.forEach((s, j) => {
      const share = s.value / g.n;
      const x0 = x(acc);
      const x1 = x(acc + share);
      const gap = j < segs.length - 1 ? 2 : 0;
      const w = Math.max(1, x1 - x0 - gap);
      const node = j === segs.length - 1
        ? el('path', { d: hBarPath(x0, y, w, barH), fill: s.color, class: 'bar' }, svg)
        : el('rect', { x: x0, y, width: w, height: barH, fill: s.color, class: 'bar' }, svg);
      bindTip(node, tipHtml(esc(g.label), [[s.key, `${s.value} of ${g.n} (${fmtPct(share)})`]]));
      if (w > 44) {
        el('text', { x: x0 + w / 2, y: y + barH / 2 + 4, 'text-anchor': 'middle', fill: s.key === 'Happiness' ? '#0b0b0b' : '#ffffff', 'font-size': 11, 'pointer-events': 'none' }, svg, fmtPct(share));
      }
      acc += share;
    });
  });
}

// ---------- Chart: frame-by-frame lines ----------

function framesChart(container, frames) {
  const pts = frames.filter((f) => isNum(f.timestamp));
  if (pts.length < 2) return emptyChart(container, 'Fewer than two frames with a detected face.');
  const width = chartWidth(container);
  const m = { top: 12, right: 16, bottom: 58, left: 44 };
  const height = 280;
  const t0 = Math.min(...pts.map((f) => f.timestamp));
  const t1 = Math.max(...pts.map((f) => f.timestamp));
  const x = scale(t0, t1, m.left, width - m.right);
  const y = scale(-1, 1, height - m.bottom, m.top);
  const svg = makeSvg(container, width, height, 'Valence and arousal per frame');
  for (const t of [-1, -0.5, 0, 0.5, 1]) {
    el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }, svg);
    el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, fmtSigned(t, 1));
  }
  for (const t of niceTicks(t0, t1, 6)) {
    el('text', { x: x(t), y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, `${fmtNum(t, 1)}s`);
  }
  el('text', { x: (m.left + width - m.right) / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-title' }, svg, 'Time in clip (s)');

  // Emotion strip under the plot: one cell per frame, colored by that frame's predicted emotion.
  const stripY = height - m.bottom + 24;
  pts.forEach((f, i) => {
    const xa = i === 0 ? x(t0) : (x(pts[i - 1].timestamp) + x(f.timestamp)) / 2;
    const xb = i === pts.length - 1 ? x(t1) : (x(f.timestamp) + x(pts[i + 1].timestamp)) / 2;
    el('rect', { x: xa, y: stripY, width: Math.max(1, xb - xa - 2), height: 8, rx: 2, fill: emotionColor(f.emotion) }, svg);
  });

  const series = [
    { key: 'valence', name: 'Valence', color: cssVar('--series-1') },
    { key: 'arousal', name: 'Arousal', color: cssVar('--series-2') },
  ];
  for (const s of series) {
    const d = pts.map((f, i) => `${i ? 'L' : 'M'}${x(f.timestamp)},${y(f[s.key])}`).join('');
    el('path', { d, stroke: s.color, class: 'series-line' }, svg);
    const last = pts[pts.length - 1];
    el('circle', { cx: x(last.timestamp), cy: y(last[s.key]), r: 4, fill: s.color, class: 'dot' }, svg);
  }

  const cross = el('line', { y1: m.top, y2: height - m.bottom, class: 'crosshair', visibility: 'hidden' }, svg);
  const markers = series.map((s) => el('circle', { r: 4.5, fill: s.color, class: 'dot', visibility: 'hidden' }, svg));
  const hit = el('rect', { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom + 34, class: 'hit' }, svg);
  hit.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    let best = pts[0];
    for (const f of pts) if (Math.abs(x(f.timestamp) - px) < Math.abs(x(best.timestamp) - px)) best = f;
    cross.setAttribute('x1', x(best.timestamp));
    cross.setAttribute('x2', x(best.timestamp));
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, i) => {
      markers[i].setAttribute('cx', x(best.timestamp));
      markers[i].setAttribute('cy', y(best[s.key]));
      markers[i].setAttribute('visibility', 'visible');
    });
    showTip(event, tipHtml(`${fmtNum(best.timestamp, 2)}s · ${esc(best.emotion)}`, [
      ['Valence', fmtSigned(best.valence)],
      ['Arousal', fmtSigned(best.arousal)],
      ['Confidence', fmtPct(best.confidence)],
    ]));
  });
  hit.addEventListener('mouseleave', () => {
    hideTip();
    cross.setAttribute('visibility', 'hidden');
    markers.forEach((mk) => mk.setAttribute('visibility', 'hidden'));
  });

  const legend = $('legendFrames');
  renderLegend(legend, series.map((s) => ({ key: s.name, color: s.color })));
  const stripLabel = document.createElement('span');
  stripLabel.className = 'legend-heading';
  stripLabel.textContent = 'Frame emotion (strip):';
  legend.appendChild(stripLabel);
  for (const e of EMOTION_ORDER.filter((name) => pts.some((f) => f.emotion === name))) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<span class="swatch swatch-strip" style="background:${emotionColor(e)}"></span>${esc(e)}`;
    legend.appendChild(item);
  }
}

function renderLegend(container, items, hidden = null, onToggle = null) {
  container.innerHTML = '';
  for (const item of items) {
    const node = document.createElement(onToggle ? 'button' : 'span');
    node.className = `legend-item${hidden && hidden.has(item.key) ? ' off' : ''}`;
    if (onToggle) {
      node.type = 'button';
      node.title = 'Show / hide';
      node.addEventListener('click', () => onToggle(item.key));
    }
    node.innerHTML = `<span class="swatch" style="background:${item.color}"></span>${esc(item.key)}${item.count !== undefined ? ` <span class="muted">${item.count}</span>` : ''}`;
    container.appendChild(node);
  }
}

// ---------- KPIs ----------

function renderKpis(rows) {
  const subjects = new Set(rows.map((c) => c.subject_id).filter(Boolean));
  const faces = rows.filter(hasFace);
  const videos = rows.filter((c) => c.media_type === 'video').length;
  const rejected = rows.filter((c) => c.outcome === 'rejected');
  const reasonCounts = {};
  for (const c of rejected) reasonCounts[c.reason] = (reasonCounts[c.reason] || 0) + 1;
  const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
  const tiles = [
    ['Participants', subjects.size, `${state.subjects.length} registered in total`],
    ['Captures', rows.length, `${rows.length - videos} photos · ${videos} videos`],
    ['Face detected', fmtPct(rows.length ? faces.length / rows.length : NaN), `${faces.length} of ${rows.length} captures`],
    ['Mean valence', fmtSigned(mean(faces.map((c) => c.valence))), 'unpleasant −1 → +1 pleasant'],
    ['Mean arousal', fmtSigned(mean(faces.map((c) => c.arousal))), 'calm −1 → +1 energized'],
    ['Mean confidence', fmtPct(mean(faces.map((c) => c.confidence))), 'top-emotion probability'],
    ['Rejected', rejected.length, topReason ? `mostly ${REASON_BY_KEY[topReason[0]].label.toLowerCase()}` : 'every capture produced a result'],
  ];
  $('kpis').innerHTML = tiles.map(([label, value, note]) => `
    <div class="kpi"><span class="kpi-label">${esc(label)}</span><span class="kpi-value">${esc(value)}</span><span class="kpi-note">${esc(note)}</span></div>`).join('');
}

// ---------- Overview ----------

function captureTip(c) {
  return tipHtml(`${esc(c.name)} · ${esc(c.emotion)}`, [
    ['When', fmtDateTime(c.created_at)],
    ['Age / gender / diet', `${c.age ?? '—'} · ${c.gender || '—'} · ${c.diet ?? '—'}`],
    ['Media', mediaLabel(c.media_type)],
    ['Valence', fmtSigned(c.valence)],
    ['Arousal', fmtSigned(c.arousal)],
    ['Confidence', fmtPct(c.confidence)],
  ]);
}

function renderOverview(rows) {
  const counts = {};
  for (const c of rows) counts[c.emotion] = (counts[c.emotion] || 0) + 1;
  const bars = EMOTION_ORDER.filter((e) => counts[e]).map((e) => ({
    label: e,
    value: counts[e],
    color: emotionColor(e),
    tip: tipHtml(esc(e), [['Captures', counts[e]], ['Share', fmtPct(counts[e] / rows.length, 1)], ['', 'Click to filter']]),
    onClick: () => {
      $('fEmotion').value = e;
      render();
    },
  })).sort((a, b) => b.value - a.value);
  barChart($('chartEmotions'), bars, { format: (r) => `${r.value} · ${fmtPct(r.value / rows.length)}`, label: 'Emotion distribution' });

  const faces = rows.filter(hasFace);
  const visible = faces.filter((c) => !state.hiddenMood.has(c.emotion));
  scatterChart($('chartMood'), {
    label: 'Valence and arousal per capture',
    square: true,
    quadrants: true,
    xDomain: [-1, 1],
    yDomain: [-1, 1],
    xLabel: 'Valence (unpleasant → pleasant)',
    yLabel: 'Arousal (calm → energized)',
    xFormat: (v) => fmtSigned(v, 1),
    yFormat: (v) => fmtSigned(v, 1),
    points: visible.map((c) => ({ x: c.valence, y: c.arousal, color: emotionColor(c.emotion), tip: captureTip(c), onClick: () => openDetail(c) })),
  });
  const present = EMOTION_ORDER.filter((e) => faces.some((c) => c.emotion === e));
  renderLegend($('legendMood'), present.map((e) => ({ key: e, color: emotionColor(e), count: faces.filter((c) => c.emotion === e).length })), state.hiddenMood, (key) => {
    toggleSet(state.hiddenMood, key);
    renderOverview(filtered());
  });

  renderTimeline(rows);
}

function renderTimeline(rows) {
  const container = $('chartTimeline');
  if (!rows.length) return emptyChart(container);
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const start = new Date(Math.min(...rows.map((c) => c.time)));
  start.setHours(0, 0, 0, 0);
  const end = new Date(Math.max(...rows.map((c) => c.time)));
  const spanDays = Math.round((end - start) / 864e5) + 1;
  const stepDays = spanDays > 120 ? 7 : 1;
  const bins = [];
  const index = new Map();
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + stepDays)) {
    const bin = { date: new Date(d), value: 0, faces: 0, subjects: new Set() };
    for (let k = 0; k < stepDays; k++) {
      const day = new Date(d);
      day.setDate(day.getDate() + k);
      index.set(dayKey(day), bin);
    }
    bins.push(bin);
  }
  for (const c of rows) {
    const bin = index.get(dayKey(c.time));
    if (!bin) continue;
    bin.value++;
    if (hasFace(c)) bin.faces++;
    bin.subjects.add(c.subject_id);
  }
  columnChart(container, bins.map((b) => ({
    label: fmtDate(b.date),
    value: b.value,
    tip: tipHtml(stepDays > 1 ? `Week of ${fmtDate(b.date)}` : b.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), [
      ['Captures', b.value],
      ['Face detected', b.faces],
      ['Participants', b.subjects.size],
    ]),
  })), { label: 'Captures over time', yLabel: stepDays > 1 ? 'Captures / week' : 'Captures / day' });
}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

// ---------- Explorer ----------

const CAPTURE_VARS = {
  valence: { label: 'Valence', get: (c) => c.valence, domain: [-1, 1], format: (v) => fmtSigned(v, 1) },
  arousal: { label: 'Arousal', get: (c) => c.arousal, domain: [-1, 1], format: (v) => fmtSigned(v, 1) },
  confidence: { label: 'Confidence', get: (c) => c.confidence, domain: [0, 1], format: (v) => fmtPct(v) },
  age: { label: 'Age (years)', get: (c) => c.age, format: (v) => fmtNum(v, 0) },
  time: { label: 'Capture date', get: (c) => c.time.getTime(), format: (v) => fmtDate(new Date(v)), time: true },
  hour: { label: 'Time of day (hour)', get: (c) => c.time.getHours() + c.time.getMinutes() / 60, domain: [0, 24], format: (v) => `${fmtNum(v, 0)}h` },
  frames: { label: 'Frames with a face (video)', get: (c) => (c.media_type === 'video' ? c.frameCount : NaN), format: (v) => fmtNum(v, 0) },
  valenceSd: { label: 'Valence variability (SD across frames)', get: (c) => c.valenceSd, format: (v) => fmtNum(v, 2) },
  arousalSd: { label: 'Arousal variability (SD across frames)', get: (c) => c.arousalSd, format: (v) => fmtNum(v, 2) },
};

const FRAME_VARS = {
  valence: { label: 'Valence', get: (f) => f.valence, domain: [-1, 1], format: (v) => fmtSigned(v, 1) },
  arousal: { label: 'Arousal', get: (f) => f.arousal, domain: [-1, 1], format: (v) => fmtSigned(v, 1) },
  confidence: { label: 'Confidence', get: (f) => f.confidence, domain: [0, 1], format: (v) => fmtPct(v) },
  timestamp: { label: 'Time in clip (s)', get: (f) => f.timestamp, format: (v) => `${fmtNum(v, 1)}s` },
  age: { label: 'Age (years)', get: (f) => f.capture.age, format: (v) => fmtNum(v, 0) },
};

const COLOR_BY = {
  emotion: 'Predicted emotion',
  diet: 'Diet',
  media_type: 'Media type',
  none: 'None',
};

function fillSelect(select, options, value) {
  select.innerHTML = Object.entries(options).map(([k, v]) => `<option value="${k}">${esc(typeof v === 'string' ? v : v.label)}</option>`).join('');
  select.value = value in options ? value : Object.keys(options)[0];
}

function setupExplorerControls() {
  const unit = $('xUnit').value;
  const vars = unit === 'frame' ? FRAME_VARS : CAPTURE_VARS;
  fillSelect($('xVar'), vars, $('xVar').value || 'valence');
  fillSelect($('yVar'), vars, $('yVar').value || 'arousal');
  const colors = unit === 'frame' ? { emotion: 'Frame emotion', diet: 'Diet', none: 'None' } : COLOR_BY;
  fillSelect($('xColor'), colors, $('xColor').value || 'emotion');
}

function groupColors(keys) {
  const slots = ['--series-1', '--series-2', '--series-3'];
  const map = {};
  keys.forEach((k, i) => {
    map[k] = i < slots.length ? cssVar(slots[i]) : '#8a8f98';
  });
  return map;
}

function renderExplorer(rows) {
  const unit = $('xUnit').value;
  const vars = unit === 'frame' ? FRAME_VARS : CAPTURE_VARS;
  const xv = vars[$('xVar').value];
  const yv = vars[$('yVar').value];
  const colorBy = $('xColor').value;

  let items;
  if (unit === 'frame') {
    items = rows.filter((c) => c.media_type === 'video').flatMap((c) =>
      c.frames.map((f, i) => ({ ...f, capture: c, index: i, diet: c.diet, media_type: c.media_type })));
  } else {
    items = rows;
  }
  const valid = items.filter((it) => isNum(xv.get(it)) && isNum(yv.get(it)));

  let colorOf;
  let legend = [];
  if (colorBy === 'emotion') {
    colorOf = (it) => emotionColor(it.emotion);
    legend = EMOTION_ORDER.filter((e) => valid.some((it) => it.emotion === e)).map((e) => ({ key: e, color: emotionColor(e), count: valid.filter((it) => it.emotion === e).length }));
  } else if (colorBy === 'none') {
    colorOf = () => cssVar('--series-1');
  } else {
    const label = (it) => (colorBy === 'media_type' ? mediaLabel(it.media_type) : it[colorBy] || 'Unknown');
    const keys = [...new Set(valid.map(label))].sort();
    const colors = groupColors(keys);
    colorOf = (it) => colors[label(it)];
    legend = keys.map((k) => ({ key: k, color: colors[k], count: valid.filter((it) => label(it) === k).length }));
  }
  const keyOf = (it) => {
    if (colorBy === 'emotion') return it.emotion;
    if (colorBy === 'media_type') return mediaLabel(it.media_type);
    if (colorBy === 'none') return '';
    return it[colorBy] || 'Unknown';
  };
  const shown = valid.filter((it) => !state.hiddenExplorer.has(keyOf(it)));

  const xs = shown.map(xv.get);
  const ys = shown.map(yv.get);
  const fit = $('xFit').checked && shown.length >= 3 ? pearson(xs, ys) : null;
  const domain = (v, vals) => v.domain || (vals.length ? niceDomain(vals) : [0, 1]);
  const xDomain = domain(xv, xs);
  let xTicks = null;
  if (xv.time && xs.length) {
    const n = 5;
    xTicks = Array.from({ length: n }, (_, i) => xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / (n - 1));
  }

  scatterChart($('chartExplorer'), {
    label: `${yv.label} versus ${xv.label}`,
    points: shown.map((it) => {
      const c = unit === 'frame' ? it.capture : it;
      const tip = unit === 'frame'
        ? tipHtml(`${esc(c.name)} · frame ${it.index + 1}`, [
          ['Emotion', it.emotion], [xv.label, xv.format(xv.get(it))], [yv.label, yv.format(yv.get(it))], ['Capture', fmtDateTime(c.created_at)],
        ])
        : tipHtml(`${esc(c.name)} · ${esc(c.emotion)}`, [
          [xv.label, xv.format(xv.get(it))], [yv.label, yv.format(yv.get(it))], ['When', fmtDateTime(c.created_at)], ['Media', mediaLabel(c.media_type)],
        ]);
      return { x: xv.get(it), y: yv.get(it), color: colorOf(it), r: unit === 'frame' ? 4 : 5.5, tip, onClick: () => openDetail(c) };
    }),
    xDomain,
    yDomain: domain(yv, ys),
    xTicks,
    xLabel: xv.label,
    yLabel: yv.label,
    xFormat: xv.format,
    yFormat: yv.format,
    fit: fit && isNum(fit.slope) ? fit : null,
  });
  renderLegend($('legendExplorer'), legend, state.hiddenExplorer, (key) => {
    toggleSet(state.hiddenExplorer, key);
    renderExplorer(filtered());
  });

  $('explorerSub').textContent = unit === 'frame'
    ? 'Each dot is one sampled video frame · click to open its capture'
    : 'Each dot is one capture · click to open it';
  const stats = [`<span>n = <strong>${shown.length}</strong></span>`];
  if (shown.length >= 3) {
    const r = pearson(xs, ys);
    stats.push(`<span>Pearson r = <strong>${fmtNum(r.r, 3)}</strong></span>`, `<span>p = <strong>${fmtP(r.p)}</strong></span>`,
      `<span>slope = <strong>${fmtNum(r.slope, 4)}</strong> per unit of x</span>`);
  } else {
    stats.push('<span class="muted">Need at least 3 points for a correlation.</span>');
  }
  if (unit === 'frame') stats.push('<span class="muted">Frames from the same clip are not independent; treat p as descriptive.</span>');
  $('explorerStats').innerHTML = stats.join('');
}

// ---------- Compare groups ----------

function groupKey(c, by, band) {
  switch (by) {
    case 'diet': return c.diet || 'Unknown';
    case 'media_type': return mediaLabel(c.media_type);
    case 'emotion': return c.emotion;
    case 'subject': return c.subject_id ? `${c.name} (${c.subject_id.slice(4, 10)})` : c.name;
    case 'age_band': {
      if (!isNum(c.age)) return 'Unknown';
      const lo = Math.floor(c.age / band) * band;
      return `${lo}–${lo + band - 1}`;
    }
    default: return 'All';
  }
}

function sortGroupKeys(keys, by) {
  if (by === 'emotion') return keys.sort((a, b) => EMOTION_ORDER.indexOf(a) - EMOTION_ORDER.indexOf(b));
  if (by === 'age_band') return keys.sort((a, b) => (parseInt(a, 10) || 999) - (parseInt(b, 10) || 999));
  return keys.sort((a, b) => a.localeCompare(b));
}

function renderCompare(rows) {
  const by = $('cGroup').value;
  const band = Number($('cBand').value);
  const metric = $('cMetric').value;
  $('cBandWrap').hidden = by !== 'age_band';
  const metricLabel = { valence: 'Valence', arousal: 'Arousal', confidence: 'Confidence' }[metric];
  const format = metric === 'confidence' ? (v) => fmtPct(v) : (v) => fmtSigned(v, 2);

  const groups = new Map();
  for (const c of rows) {
    const k = groupKey(c, by, band);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const keys = sortGroupKeys([...groups.keys()], by);

  const stats = keys.map((k) => {
    const values = groups.get(k).filter(hasFace).map((c) => c[metric]).filter(isNum);
    return { key: k, values, ...(values.length ? describe(values) : { n: 0 }) };
  });
  const withData = stats.filter((s) => s.n > 0);
  const domain = metric === 'confidence' ? [0, 1] : [-1, 1];

  ciChart($('chartCompare'), withData.map((s) => ({
    label: s.key,
    mean: s.mean,
    lo: s.lo,
    hi: s.hi,
    n: s.n,
    tip: tipHtml(esc(s.key), [
      ['n', s.n], ['Mean', format(s.mean)], ['95% CI', isNum(s.lo) ? `${format(s.lo)} to ${format(s.hi)}` : 'n < 2'],
      ['SD', fmtNum(s.sd, 3)], ['Median', format(s.median)],
    ]),
  })), { domain, metricLabel, format });

  const testable = withData.filter((s) => s.n >= 2);
  let test = '<span class="muted">A significance test needs at least two groups with n ≥ 2.</span>';
  if (testable.length === 2) {
    const w = welch(testable[0].values, testable[1].values);
    test = `<span>Welch's t-test (${esc(testable[0].key)} vs ${esc(testable[1].key)}):</span>
      <span>t = <strong>${fmtNum(w.t, 3)}</strong></span><span>df = <strong>${fmtNum(w.df, 1)}</strong></span>
      <span>p = <strong>${fmtP(w.p)}</strong></span><span>Cohen's d = <strong>${fmtNum(w.d, 2)}</strong></span>`;
  } else if (testable.length > 2) {
    const a = anova(testable.map((s) => s.values));
    test = `<span>One-way ANOVA across ${testable.length} groups:</span>
      <span>F(${a.d1}, ${a.d2}) = <strong>${fmtNum(a.f, 3)}</strong></span>
      <span>p = <strong>${fmtP(a.p)}</strong></span><span>η² = <strong>${fmtNum(a.eta2, 3)}</strong></span>`;
  }
  if (by !== 'subject' && testable.length >= 2) {
    test += '<span class="muted">Repeated captures of one participant are not independent; filter to one capture per person for a strict test.</span>';
  }
  $('compareTest').innerHTML = test;

  $('compareTable').innerHTML = `
    <thead><tr><th>Group</th><th class="num">Captures</th><th class="num">n (face)</th><th class="num">Mean</th><th class="num">SD</th>
      <th class="num">Median</th><th class="num">Min</th><th class="num">Max</th><th class="num">95% CI</th></tr></thead>
    <tbody>${stats.map((s) => `<tr><td>${esc(s.key)}</td><td class="num">${groups.get(s.key).length}</td><td class="num">${s.n}</td>
      <td class="num">${s.n ? format(s.mean) : '—'}</td><td class="num">${fmtNum(s.sd, 3)}</td><td class="num">${s.n ? format(s.median) : '—'}</td>
      <td class="num">${s.n ? format(s.min) : '—'}</td><td class="num">${s.n ? format(s.max) : '—'}</td>
      <td class="num">${isNum(s.lo) ? `${format(s.lo)} to ${format(s.hi)}` : '—'}</td></tr>`).join('')}</tbody>`;

  const present = EMOTION_ORDER.filter((e) => rows.some((c) => c.emotion === e));
  stackedChart($('chartMix'), keys.map((k) => {
    const g = groups.get(k);
    return { label: k, n: g.length, segments: present.map((e) => ({ key: e, value: g.filter((c) => c.emotion === e).length, color: emotionColor(e) })) };
  }));
  renderLegend($('legendMix'), present.map((e) => ({ key: e, color: emotionColor(e) })));
}

// ---------- Veg vs Non-Veg ----------

const DIETS = ['Veg', 'Non-Veg'];
const DIET_STYLE = {
  Veg: { token: '--diet-veg', shape: 'circle' },
  'Non-Veg': { token: '--diet-nonveg', shape: 'diamond' },
};
const VA = {
  valence: { label: 'Valence', axis: 'Valence (unpleasant → pleasant)' },
  arousal: { label: 'Arousal', axis: 'Arousal (calm → energized)' },
};
const DIET_VIEWS = {
  moodmap: {
    metric: false,
    sub: 'Each faint mark is one unit; the large mark is the group mean with its 95% CI on both axes. Shows whether the groups sit in different parts of the mood space.',
  },
  box: {
    metric: false,
    sub: 'Box = middle 50% (Q1–Q3), line = median, whiskers = 1.5 × IQR, marks = individual units. Shows spread, skew and outliers, not just the average.',
  },
  means: {
    metric: false,
    sub: 'Group mean with 95% confidence interval for both measures. Non-overlapping intervals suggest a real difference; the test below says how strong.',
  },
  hist: {
    metric: true,
    sub: 'Share of each group falling in each 0.2-wide bin, so groups of different size compare fairly. Shows the shape of each distribution.',
  },
  ecdf: {
    metric: true,
    sub: 'Share of each group at or below each value. A curve lying to the right means that group scores higher overall; hover to read both groups at any value.',
  },
  clip: {
    metric: false,
    sub: 'Mean per 0.5 s of the video clip; a shaded 95% CI band appears once every point has n ≥ 3. Shows whether the groups react differently as the clip goes on. Videos only.',
  },
};

const dietColor = (d) => cssVar(DIET_STYLE[d].token);
const dietShape = (d) => DIET_STYLE[d].shape;
const unitKey = (c) => c.subject_id || `name:${c.name}`;

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Two-sample Kolmogorov–Smirnov: largest vertical gap between the two cumulative curves, asymptotic p.
function ks(a, b) {
  const sa = [...a].sort((p, q) => p - q);
  const sb = [...b].sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < sa.length && j < sb.length) {
    const v = Math.min(sa[i], sb[j]);
    while (i < sa.length && sa[i] <= v) i++;
    while (j < sb.length && sb[j] <= v) j++;
    d = Math.max(d, Math.abs(i / sa.length - j / sb.length));
  }
  const en = Math.sqrt((sa.length * sb.length) / (sa.length + sb.length));
  const lambda = (en + 0.12 + 0.11 / en) * d;
  let p = 0;
  for (let k = 1; k <= 100; k++) p += 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * lambda * lambda);
  return { d, p: Math.min(1, Math.max(0, p)) };
}

// Small deterministic jitter so the same point doesn't jump around between renders.
function jitter(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000 - 0.5;
}

// One item per capture, or one per participant (the mean of their captures). Only captures with a face.
function dietUnits(rows, unit) {
  const faces = rows.filter((c) => hasFace(c) && DIETS.includes(c.diet));
  if (unit === 'capture') {
    return faces.map((c) => ({
      key: c.capture_id, diet: c.diet, valence: c.valence, arousal: c.arousal, captures: [c],
      title: `${esc(c.name)} · ${esc(c.emotion)}`, onClick: () => openDetail(c),
    }));
  }
  const by = new Map();
  for (const c of faces) {
    const k = `${c.diet}|${unitKey(c)}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c);
  }
  return [...by.entries()].map(([k, cs]) => ({
    key: k,
    diet: cs[0].diet,
    valence: mean(cs.map((c) => c.valence)),
    arousal: mean(cs.map((c) => c.arousal)),
    captures: cs,
    title: esc(cs[0].name),
    onClick: () => {
      $('fSearch').value = cs[0].subject_id || cs[0].name;
      selectTab('captures');
    },
  }));
}

function unitTip(u) {
  return tipHtml(u.title, [
    ['Diet', u.diet],
    ['Valence', fmtSigned(u.valence)],
    ['Arousal', fmtSigned(u.arousal)],
    u.captures.length > 1 ? ['Captures averaged', u.captures.length] : ['When', fmtDateTime(u.captures[0].created_at)],
    ['', u.captures.length > 1 ? 'Click to list their captures' : 'Click to open'],
  ]);
}

// A 95% CI is drawn only from n >= 3 (at n = 2 it spans several times the whole −1…+1 scale).
const MIN_CI_N = 3;
// Below this, a group is shown as its points only: quartiles of 2–4 values are not a meaningful box.
const MIN_BOX_N = 5;

function ciSpan(s) {
  if (!(s.n >= MIN_CI_N) || !isNum(s.lo)) return null;
  return { lo: Math.max(-1, s.lo), hi: Math.min(1, s.hi), clipLo: s.lo < -1, clipHi: s.hi > 1 };
}

// CI whisker from a to b (SVG coordinates) along x or y, with an arrowhead on any end cut off at the scale edge.
function ciLine(svg, axis, a, b, at, color, clipA, clipB, width = 3) {
  const pt = (v, off) => (axis === 'x' ? [v, at + off] : [at + off, v]);
  const [x1, y1] = pt(a, 0);
  const [x2, y2] = pt(b, 0);
  el('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round' }, svg);
  const arrow = (v, dir) => {
    const tip = pt(v, 0);
    const l = pt(v - dir * 7, -5);
    const r = pt(v - dir * 7, 5);
    el('path', { d: `M${l[0]},${l[1]}L${tip[0]},${tip[1]}L${r[0]},${r[1]}`, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  };
  if (clipA) arrow(a, Math.sign(a - b) || -1);
  if (clipB) arrow(b, Math.sign(b - a) || 1);
}

const ciText = (s) => (s.n >= MIN_CI_N && isNum(s.lo) ? `${fmtSigned(s.lo)} to ${fmtSigned(s.hi)}` : `needs n ≥ ${MIN_CI_N}`);

function dietGroups(units) {
  return DIETS.map((d) => {
    const us = units.filter((u) => u.diet === d);
    const stat = (k) => (us.length ? describe(us.map((u) => u[k])) : { n: 0 });
    return { diet: d, units: us, valence: stat('valence'), arousal: stat('arousal') };
  }).filter((g) => g.units.length);
}

function vaAxisX(svg, x, y0, y1, label, plotMid, height) {
  for (const t of [-1, -0.5, 0, 0.5, 1]) {
    el('line', { x1: x(t), x2: x(t), y1: y0, y2: y1, class: t === 0 ? 'axis' : 'grid' }, svg);
    el('text', { x: x(t), y: y1 + 16, 'text-anchor': 'middle', class: 'tick' }, svg, fmtSigned(t, 1));
  }
  if (label) el('text', { x: plotMid, y: height, 'text-anchor': 'middle', class: 'axis-title' }, svg, label);
}

// Mood map: every unit faint, group means large with a 95% CI cross.
function dietMoodMap(container, groups) {
  const chart = scatterChart(container, {
    label: 'Valence and arousal by diet',
    square: true,
    quadrants: true,
    xDomain: [-1, 1],
    yDomain: [-1, 1],
    xLabel: VA.valence.axis,
    yLabel: VA.arousal.axis,
    xFormat: (v) => fmtSigned(v, 1),
    yFormat: (v) => fmtSigned(v, 1),
    points: groups.flatMap((g) => g.units.map((u) => ({
      x: u.valence, y: u.arousal, r: 4.5, opacity: 0.45, color: dietColor(g.diet), shape: dietShape(g.diet), tip: unitTip(u), onClick: u.onClick,
    }))),
  });
  if (!chart) return;
  const { svg, x, y } = chart;
  for (const g of groups) {
    const v = g.valence;
    const a = g.arousal;
    const color = dietColor(g.diet);
    const cv = ciSpan(v);
    const ca = ciSpan(a);
    if (cv) ciLine(svg, 'x', x(cv.lo), x(cv.hi), y(a.mean), color, cv.clipLo, cv.clipHi);
    if (ca) ciLine(svg, 'y', y(ca.lo), y(ca.hi), x(v.mean), color, ca.clipLo, ca.clipHi);
    const mk = marker(svg, dietShape(g.diet), x(v.mean), y(a.mean), 9, { fill: color, class: 'dot' });
    bindTip(mk, tipHtml(`${esc(g.diet)} mean`, [
      ['n', v.n], ['Valence', `${fmtSigned(v.mean)} (95% CI ${ciText(v)})`],
      ['Arousal', `${fmtSigned(a.mean)} (95% CI ${ciText(a)})`],
    ]));
    el('text', { x: x(v.mean) + 14, y: y(a.mean) - 10, class: 'bar-label direct-label' }, svg, `${g.diet} mean`);
  }
}

// Box plots: one panel per measure, one row per diet, with the individual units jittered over the box.
function dietBox(container, groups) {
  const width = chartWidth(container);
  const labelW = 96;
  const m = { top: 26, right: 20, bottom: 40 };
  const rowH = 54;
  const panelH = groups.length * rowH + m.top + 30;
  const height = panelH * 2 + 10;
  const x = scale(-1, 1, labelW, width - m.right);
  const svg = makeSvg(container, width, height, 'Valence and arousal distribution by diet');
  ['valence', 'arousal'].forEach((metric, pi) => {
    const top = pi * (panelH + 10);
    const y0 = top + m.top;
    const y1 = y0 + groups.length * rowH;
    el('text', { x: labelW, y: top + 14, class: 'cat-label panel-title' }, svg, VA[metric].axis);
    vaAxisX(svg, x, y0, y1, '', 0, 0);
    groups.forEach((g, i) => {
      const cy = y0 + i * rowH + rowH / 2;
      const values = g.units.map((u) => u[metric]).sort((a, b) => a - b);
      const q1 = quantile(values, 0.25);
      const q2 = quantile(values, 0.5);
      const q3 = quantile(values, 0.75);
      const iqr = q3 - q1;
      const lo = Math.min(...values.filter((v) => v >= q1 - 1.5 * iqr));
      const hi = Math.max(...values.filter((v) => v <= q3 + 1.5 * iqr));
      const color = dietColor(g.diet);
      const boxH = 26;
      el('text', { x: labelW - 10, y: cy + 4, 'text-anchor': 'end', class: 'cat-label' }, svg, g.diet);
      if (values.length < MIN_BOX_N) {
        const med = el('line', { x1: x(q2), x2: x(q2), y1: cy - boxH / 2, y2: cy + boxH / 2, stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round' }, svg);
        bindTip(med, tipHtml(`${esc(g.diet)} · ${VA[metric].label}`, [['n', values.length], ['Median', fmtSigned(q2)], ['', `No box: needs n ≥ ${MIN_BOX_N}`]]));
        for (const u of g.units) bindTip(marker(svg, dietShape(g.diet), x(u[metric]), cy, 5, { fill: color, class: 'dot' }), unitTip(u), u.onClick);
        return;
      }
      el('line', { x1: x(lo), x2: x(q1), y1: cy, y2: cy, stroke: color, 'stroke-width': 2 }, svg);
      el('line', { x1: x(q3), x2: x(hi), y1: cy, y2: cy, stroke: color, 'stroke-width': 2 }, svg);
      for (const w of [lo, hi]) el('line', { x1: x(w), x2: x(w), y1: cy - 7, y2: cy + 7, stroke: color, 'stroke-width': 2 }, svg);
      const box = el('rect', { x: x(q1), y: cy - boxH / 2, width: Math.max(2, x(q3) - x(q1)), height: boxH, rx: 4, fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 2 }, svg);
      el('line', { x1: x(q2), x2: x(q2), y1: cy - boxH / 2, y2: cy + boxH / 2, stroke: color, 'stroke-width': 3 }, svg);
      bindTip(box, tipHtml(`${esc(g.diet)} · ${VA[metric].label}`, [
        ['n', values.length], ['Median', fmtSigned(q2)], ['Q1 – Q3', `${fmtSigned(q1)} to ${fmtSigned(q3)}`],
        ['Mean', fmtSigned(g[metric].mean)], ['Range', `${fmtSigned(values[0])} to ${fmtSigned(values[values.length - 1])}`],
      ]));
      for (const u of g.units) {
        const dot = marker(svg, dietShape(g.diet), x(u[metric]), cy + jitter(u.key) * (boxH - 6), 4, { fill: color, 'fill-opacity': 0.6, class: 'dot' });
        bindTip(dot, unitTip(u), u.onClick);
      }
    });
  });
  el('text', { x: (labelW + width - m.right) / 2, y: height - 2, 'text-anchor': 'middle', class: 'axis-title' }, svg, '−1 = most unpleasant / calm · +1 = most pleasant / energized');
}

// Mean ± 95% CI: one row per measure, the two diets side by side within it.
function dietMeans(container, groups) {
  const width = chartWidth(container);
  const labelW = 96;
  const m = { top: 10, right: 120, bottom: 40 };
  const rowH = 70;
  const height = 2 * rowH + m.top + m.bottom;
  const x = scale(-1, 1, labelW, width - m.right);
  const svg = makeSvg(container, width, height, 'Mean valence and arousal by diet');
  vaAxisX(svg, x, m.top, m.top + 2 * rowH, 'Group mean (95% CI)', (labelW + width - m.right) / 2, height - 4);
  ['valence', 'arousal'].forEach((metric, ri) => {
    const mid = m.top + ri * rowH + rowH / 2;
    el('text', { x: labelW - 10, y: mid + 4, 'text-anchor': 'end', class: 'cat-label' }, svg, VA[metric].label);
    groups.forEach((g, gi) => {
      const s = g[metric];
      const cy = mid + (gi - (groups.length - 1) / 2) * 18;
      const color = dietColor(g.diet);
      const ci = ciSpan(s);
      if (ci) ciLine(svg, 'x', x(ci.lo), x(ci.hi), cy, color, ci.clipLo, ci.clipHi, 2.5);
      marker(svg, dietShape(g.diet), x(s.mean), cy, 6, { fill: color, class: 'dot' });
      el('text', { x: width - m.right + 10, y: cy + 4, class: 'bar-label' }, svg, `${g.diet} ${fmtSigned(s.mean)}`);
      const hit = el('rect', { x: labelW, y: cy - 9, width: width - m.right - labelW, height: 18, class: 'hit' }, svg);
      bindTip(hit, tipHtml(`${esc(g.diet)} · ${VA[metric].label}`, [
        ['n', s.n], ['Mean', fmtSigned(s.mean)], ['95% CI', ciText(s)], ['SD', fmtNum(s.sd, 3)],
      ]));
    });
  });
}

// Histogram: share of each group per 0.2-wide bin, bars side by side.
function dietHist(container, groups, metric) {
  const width = chartWidth(container);
  const m = { top: 26, right: 16, bottom: 44, left: 48 };
  const height = 310;
  const binW = 0.2;
  const nBins = Math.round(2 / binW);
  const binOf = (v) => Math.min(nBins - 1, Math.max(0, Math.floor((v + 1) / binW)));
  const shares = groups.map((g) => {
    const counts = new Array(nBins).fill(0);
    for (const u of g.units) counts[binOf(u[metric])]++;
    return counts.map((c) => ({ count: c, share: c / g.units.length }));
  });
  const max = Math.max(0.05, ...shares.flat().map((s) => s.share));
  const ticks = niceTicks(0, max, 4);
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + ticks[1] - ticks[0]).toFixed(10));
  const top = Math.max(max, ticks[ticks.length - 1]);
  const x = scale(-1, 1, m.left, width - m.right);
  const y = scale(0, top, height - m.bottom, m.top);
  const svg = makeSvg(container, width, height, `${VA[metric].label} histogram by diet`);
  for (const t of ticks) {
    el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }, svg);
    el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, fmtPct(t));
  }
  for (const t of [-1, -0.5, 0, 0.5, 1]) el('text', { x: x(t), y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, fmtSigned(t, 1));
  el('text', { x: (m.left + width - m.right) / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-title' }, svg, VA[metric].axis);
  el('text', { x: 4, y: 10, class: 'axis-title' }, svg, 'Share of group');
  const slot = x(-1 + binW) - x(-1);
  const barW = Math.max(2, (slot - 6) / groups.length - 2);
  for (let b = 0; b < nBins; b++) {
    const lo = -1 + b * binW;
    groups.forEach((g, gi) => {
      const s = shares[gi][b];
      const bx = x(lo) + 3 + gi * (barW + 2);
      if (s.count) el('path', { d: vBarPath(bx, y(0), barW, y(0) - y(s.share)), fill: dietColor(g.diet), class: 'bar' }, svg);
    });
    const hit = el('rect', { x: x(lo), y: m.top, width: slot, height: height - m.top - m.bottom, class: 'hit' }, svg);
    bindTip(hit, tipHtml(`${VA[metric].label} ${fmtSigned(lo, 1)} to ${fmtSigned(lo + binW, 1)}`,
      groups.map((g, gi) => [g.diet, `${shares[gi][b].count} of ${g.units.length} (${fmtPct(shares[gi][b].share)})`])));
  }
}

// Empirical cumulative distribution: step line per diet, crosshair readout of both at the hovered value.
function dietEcdf(container, groups, metric) {
  const width = chartWidth(container);
  const m = { top: 26, right: 16, bottom: 44, left: 48 };
  const height = 330;
  const x = scale(-1, 1, m.left, width - m.right);
  const y = scale(0, 1, height - m.bottom, m.top);
  const svg = makeSvg(container, width, height, `Cumulative ${VA[metric].label.toLowerCase()} by diet`);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }, svg);
    el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, fmtPct(t));
  }
  for (const t of [-1, -0.5, 0, 0.5, 1]) {
    el('line', { x1: x(t), x2: x(t), y1: m.top, y2: height - m.bottom, class: 'grid' }, svg);
    el('text', { x: x(t), y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, fmtSigned(t, 1));
  }
  el('text', { x: (m.left + width - m.right) / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-title' }, svg, VA[metric].axis);
  el('text', { x: 4, y: 10, class: 'axis-title' }, svg, 'Share of group at or below');
  const sorted = groups.map((g) => g.units.map((u) => u[metric]).sort((a, b) => a - b));
  const cdf = (vals, v) => {
    let k = 0;
    while (k < vals.length && vals[k] <= v) k++;
    return k / vals.length;
  };
  groups.forEach((g, gi) => {
    const vals = sorted[gi];
    let d = `M${x(-1)},${y(0)}`;
    vals.forEach((v, i) => {
      d += `H${x(v)}V${y((i + 1) / vals.length)}`;
    });
    d += `H${x(1)}`;
    el('path', { d, stroke: dietColor(g.diet), class: 'series-line' }, svg);
    const med = quantile(vals, 0.5);
    marker(svg, dietShape(g.diet), x(med), y(0.5), 5, { fill: dietColor(g.diet), class: 'dot' });
  });
  const cross = el('line', { y1: m.top, y2: height - m.bottom, class: 'crosshair', visibility: 'hidden' }, svg);
  const hit = el('rect', { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom, class: 'hit' }, svg);
  hit.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const v = Math.max(-1, Math.min(1, -1 + ((px - m.left) / (width - m.left - m.right)) * 2));
    cross.setAttribute('x1', x(v));
    cross.setAttribute('x2', x(v));
    cross.setAttribute('visibility', 'visible');
    showTip(event, tipHtml(`${VA[metric].label} ≤ ${fmtSigned(v)}`, groups.map((g, gi) => [g.diet, fmtPct(cdf(sorted[gi], v))])));
  });
  hit.addEventListener('mouseleave', () => {
    hideTip();
    cross.setAttribute('visibility', 'hidden');
  });
}

// Over the clip: per 0.5 s bin, mean across units (a participant's captures are averaged first).
function dietClip(container, rows, unit) {
  const binW = 0.5;
  const videos = rows.filter((c) => c.media_type === 'video' && DIETS.includes(c.diet));
  const series = [];
  for (const d of DIETS) {
    // unit -> bin -> {valence: [], arousal: []}
    const perUnit = new Map();
    for (const c of videos.filter((v) => v.diet === d)) {
      const k = unit === 'capture' ? c.capture_id : unitKey(c);
      if (!perUnit.has(k)) perUnit.set(k, new Map());
      const bins = perUnit.get(k);
      for (const f of c.frames) {
        if (!isNum(f.timestamp) || !isNum(f.valence) || !isNum(f.arousal)) continue;
        const b = Math.floor(f.timestamp / binW);
        if (!bins.has(b)) bins.set(b, { valence: [], arousal: [] });
        bins.get(b).valence.push(f.valence);
        bins.get(b).arousal.push(f.arousal);
      }
    }
    const bins = new Map();
    for (const unitBins of perUnit.values()) {
      for (const [b, v] of unitBins) {
        if (!bins.has(b)) bins.set(b, { valence: [], arousal: [] });
        bins.get(b).valence.push(mean(v.valence));
        bins.get(b).arousal.push(mean(v.arousal));
      }
    }
    const pts = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => ({
      t: (b + 0.5) * binW, valence: describe(v.valence), arousal: describe(v.arousal),
    }));
    if (pts.length) series.push({ diet: d, units: perUnit.size, pts });
  }
  if (!series.length || series.every((s) => s.pts.length < 2)) return emptyChart(container, 'No video frames with a detected face for these filters.');

  const width = chartWidth(container);
  const m = { top: 24, right: 16, bottom: 40, left: 48 };
  const panelH = 210;
  const height = panelH * 2 + m.bottom + 10;
  const tMax = Math.max(...series.flatMap((s) => s.pts.map((p) => p.t))) + binW / 2;
  const x = scale(0, tMax, m.left, width - m.right);
  const svg = makeSvg(container, width, height, 'Valence and arousal over the clip by diet');
  ['valence', 'arousal'].forEach((metric, pi) => {
    const top = pi * (panelH + 10);
    const y = scale(-1, 1, top + panelH - 10, top + m.top);
    el('text', { x: m.left, y: top + 14, class: 'cat-label panel-title' }, svg, VA[metric].axis);
    for (const t of [-1, -0.5, 0, 0.5, 1]) {
      el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }, svg);
      el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, fmtSigned(t, 1));
    }
    for (const s of series) {
      const color = dietColor(s.diet);
      const band = s.pts.filter((p) => p[metric].n >= MIN_CI_N && isNum(p[metric].lo));
      if (band.length >= 2 && band.length === s.pts.length) {
        const up = band.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(Math.min(1, p[metric].hi))}`).join('');
        const down = [...band].reverse().map((p) => `L${x(p.t)},${y(Math.max(-1, p[metric].lo))}`).join('');
        el('path', { d: `${up}${down}Z`, fill: color, 'fill-opacity': 0.14, stroke: 'none' }, svg);
      }
      el('path', { d: s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p[metric].mean)}`).join(''), stroke: color, class: 'series-line' }, svg);
      const last = s.pts[s.pts.length - 1];
      marker(svg, dietShape(s.diet), x(last.t), y(last[metric].mean), 4.5, { fill: color, class: 'dot' });
    }
  });
  for (const t of niceTicks(0, tMax, 6)) el('text', { x: x(t), y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, `${fmtNum(t, 1)}s`);
  el('text', { x: (m.left + width - m.right) / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-title' }, svg, 'Time in clip (s)');

  const cross = el('line', { y1: m.top, y2: height - m.bottom, class: 'crosshair', visibility: 'hidden' }, svg);
  const hit = el('rect', { x: m.left, y: 0, width: width - m.left - m.right, height: height - m.bottom, class: 'hit' }, svg);
  hit.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const t = Math.max(0, Math.min(tMax - 1e-9, ((px - m.left) / (width - m.left - m.right)) * tMax));
    const bt = (Math.floor(t / binW) + 0.5) * binW;
    cross.setAttribute('x1', x(bt));
    cross.setAttribute('x2', x(bt));
    cross.setAttribute('visibility', 'visible');
    const rowsTip = [];
    for (const s of series) {
      const p = s.pts.find((q) => Math.abs(q.t - bt) < 1e-9);
      rowsTip.push([`${s.diet} valence`, p ? fmtSigned(p.valence.mean) : '—'], [`${s.diet} arousal`, p ? `${fmtSigned(p.arousal.mean)} (n=${p.arousal.n})` : '—']);
    }
    showTip(event, tipHtml(`${fmtNum(bt - binW / 2, 1)}–${fmtNum(bt + binW / 2, 1)} s`, rowsTip));
  });
  hit.addEventListener('mouseleave', () => {
    hideTip();
    cross.setAttribute('visibility', 'hidden');
  });
}

function renderDiet(rows) {
  const view = $('dView').value;
  const unit = $('dUnit').value;
  const metric = $('dMetric').value;
  const spec = DIET_VIEWS[view];
  $('dMetricWrap').hidden = !spec.metric;
  $('dietSub').textContent = spec.sub;

  // The clip view only uses videos, so the legend, tests and table below it do too.
  const pool = view === 'clip' ? rows.filter((c) => c.media_type === 'video') : rows;
  const units = dietUnits(pool, unit);
  const groups = dietGroups(units);
  const container = $('chartDiet');
  container.classList.toggle('chart-square', view === 'moodmap');
  const unitWord = unit === 'participant' ? (view === 'clip' ? 'participants with video' : 'participants') : (view === 'clip' ? 'videos' : 'captures');

  if (view === 'clip') dietClip(container, rows, unit);
  else if (!groups.length) emptyChart(container, 'No Veg or Non-Veg captures with a detected face match these filters.');
  else if (view === 'moodmap') dietMoodMap(container, groups);
  else if (view === 'box') dietBox(container, groups);
  else if (view === 'means') dietMeans(container, groups);
  else if (view === 'hist') dietHist(container, groups, metric);
  else if (view === 'ecdf') dietEcdf(container, groups, metric);

  $('legendDiet').innerHTML = groups.map((g) => `<span class="legend-item"><span class="swatch ${dietShape(g.diet)}" style="background:${dietColor(g.diet)}"></span>${esc(g.diet)} <span class="muted">${g.units.length} ${unitWord}</span></span>`).join('');

  // Significance for both measures; KS (shape of the whole distribution) only on the distribution views.
  const parts = [];
  const missing = DIETS.filter((d) => !groups.some((g) => g.diet === d));
  if (groups.length < 2) {
    parts.push(`<span class="muted">No ${missing.map(esc).join(' or ')} ${view === 'clip' ? 'videos' : 'captures'} with a detected face here${$('fDiet').value ? ': clear the Diet filter above to compare both groups' : ''}.</span>`);
  } else {
    const small = groups.filter((g) => g.units.length < MIN_BOX_N);
    if (small.length) {
      parts.push(`<span class="warn-note">Too few to compare reliably: ${small.map((g) => `${esc(g.diet)} has ${g.units.length} ${unitWord}`).join(', ')}. Treat the numbers below as a preview; intervals need n ≥ ${MIN_CI_N} and boxes n ≥ ${MIN_BOX_N}.</span>`);
    }
    const [a, b] = groups;
    for (const k of ['valence', 'arousal']) {
      const xa = a.units.map((u) => u[k]);
      const xb = b.units.map((u) => u[k]);
      if (xa.length < 2 || xb.length < 2) {
        parts.push(`<span class="muted">${VA[k].label}: need n ≥ 2 in each group for a test.</span>`);
        continue;
      }
      const w = welch(xa, xb);
      let line = `<span>${VA[k].label}: Δ mean (${esc(a.diet)} − ${esc(b.diet)}) = <strong>${fmtSigned(mean(xa) - mean(xb))}</strong>, Welch t = <strong>${fmtNum(w.t, 2)}</strong>, p = <strong>${fmtP(w.p)}</strong>, d = <strong>${fmtNum(w.d, 2)}</strong>`;
      if (spec.metric && k === metric) {
        const s = ks(xa, xb);
        line += `, KS D = <strong>${fmtNum(s.d, 2)}</strong> (p = <strong>${fmtP(s.p)}</strong>)`;
      }
      parts.push(`${line}</span>`);
    }
    parts.push(unit === 'capture'
      ? '<span class="muted">Captures from the same person are not independent; switch Unit to Participants for a stricter test.</span>'
      : '<span class="muted">One mean per participant, so each person counts once.</span>');
  }
  const unknown = pool.filter((c) => hasFace(c) && !DIETS.includes(c.diet)).length;
  if (unknown) parts.push(`<span class="muted">${unknown} capture${unknown === 1 ? '' : 's'} without a Veg/Non-Veg diet left out.</span>`);
  $('dietTest').innerHTML = parts.join('');

  const cell = (s, f) => (s.n ? f(s) : '—');
  $('dietTable').innerHTML = `
    <thead><tr><th>Diet</th><th class="num">n (${unitWord})</th>
      <th class="num">Valence mean</th><th class="num">95% CI</th><th class="num">SD</th><th class="num">Median</th>
      <th class="num">Arousal mean</th><th class="num">95% CI</th><th class="num">SD</th><th class="num">Median</th></tr></thead>
    <tbody>${groups.map((g) => `<tr><td><span class="swatch ${dietShape(g.diet)}" style="background:${dietColor(g.diet)}"></span> ${esc(g.diet)}</td>
      <td class="num">${g.units.length}</td>
      ${['valence', 'arousal'].map((k) => `<td class="num">${cell(g[k], (s) => fmtSigned(s.mean))}</td>
        <td class="num">${g[k].n ? ciText(g[k]) : '—'}</td>
        <td class="num">${fmtNum(g[k].sd, 3)}</td><td class="num">${cell(g[k], (s) => fmtSigned(s.median))}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

// ---------- Tables ----------

function sortRows(rows, { key, dir }, getters) {
  const get = getters[key];
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const missingA = va === null || va === undefined || (typeof va === 'number' && Number.isNaN(va));
    const missingB = vb === null || vb === undefined || (typeof vb === 'number' && Number.isNaN(vb));
    if (missingA || missingB) return missingA - missingB;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
}

function tableHead(columns, sort) {
  return `<thead><tr>${columns.map((c) => `<th data-key="${c.key}" class="${c.num ? 'num' : ''}" aria-sort="${sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(c.label)}${sort.key === c.key ? `<span class="arrow">${sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>`;
}

function bindSort(table, which, rerender) {
  table.querySelectorAll('th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const sort = state.sort[which];
      if (sort.key === th.dataset.key) sort.dir *= -1;
      else Object.assign(sort, { key: th.dataset.key, dir: th.classList.contains('num') ? -1 : 1 });
      rerender();
    });
  });
}

const CAPTURE_COLUMNS = [
  { key: 'created_at', label: 'When', get: (c) => c.time.getTime() },
  { key: 'name', label: 'Participant', get: (c) => c.name || '' },
  { key: 'age', label: 'Age', num: true, get: (c) => c.age },
  { key: 'diet', label: 'Diet', get: (c) => c.diet || '' },
  { key: 'media_type', label: 'Media', get: (c) => c.media_type },
  { key: 'emotion', label: 'Emotion', get: (c) => c.emotion },
  { key: 'confidence', label: 'Confidence', num: true, get: (c) => c.confidence },
  { key: 'valence', label: 'Valence', num: true, get: (c) => c.valence },
  { key: 'arousal', label: 'Arousal', num: true, get: (c) => c.arousal },
  { key: 'frames', label: 'Frames', num: true, get: (c) => c.frameCount },
];

function renderCaptures(rows) {
  const table = $('capturesTable');
  const getters = Object.fromEntries(CAPTURE_COLUMNS.map((c) => [c.key, c.get]));
  const sorted = sortRows(rows, state.sort.captures, getters);
  $('capturesSub').textContent = `${rows.length} captures · click a row for media and frame-by-frame results`;
  table.className = 'data-table sortable clickable';
  table.innerHTML = tableHead(CAPTURE_COLUMNS, state.sort.captures) + `<tbody>${sorted.map((c) => `
    <tr data-id="${esc(c.capture_id)}" class="${state.excluded.has(c.capture_id) ? 'excluded' : ''}">
      <td>${esc(fmtDateTime(c.created_at))}</td><td>${esc(c.name)}</td><td class="num">${esc(c.age ?? '—')}</td><td>${esc(c.diet ?? '—')}</td>
      <td>${mediaLabel(c.media_type)}</td><td>${outcomeChip(c)}</td><td class="num">${hasFace(c) ? fmtPct(c.confidence) : '—'}</td>
      <td class="num">${fmtSigned(c.valence)}</td><td class="num">${fmtSigned(c.arousal)}</td><td class="num">${c.media_type === 'video' ? c.frameCount : '—'}</td>
    </tr>`).join('')}</tbody>`;
  bindSort(table, 'captures', () => renderCaptures(filtered()));
  const byId = new Map(rows.map((c) => [c.capture_id, c]));
  table.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => openDetail(byId.get(tr.dataset.id))));
}

function participantRows(rows) {
  const map = new Map();
  for (const c of rows) {
    if (!map.has(c.subject_id)) map.set(c.subject_id, []);
    map.get(c.subject_id).push(c);
  }
  return [...map.entries()].map(([id, caps]) => {
    const faces = caps.filter(hasFace);
    const counts = {};
    for (const c of faces) counts[c.emotion] = (counts[c.emotion] || 0) + 1;
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const latest = caps.reduce((a, b) => (a.time > b.time ? a : b));
    return {
      subject_id: id,
      name: latest.name,
      roll_no: latest.roll_no,
      age: latest.age,
      gender: latest.gender,
      diet: latest.diet,
      captures: caps.length,
      faces: faces.length,
      dominant: dominant ? dominant[0] : 'Unknown',
      valence: mean(faces.map((c) => c.valence)),
      arousal: mean(faces.map((c) => c.arousal)),
      confidence: mean(faces.map((c) => c.confidence)),
      first: Math.min(...caps.map((c) => c.time)),
      last: Math.max(...caps.map((c) => c.time)),
    };
  });
}

const PARTICIPANT_COLUMNS = [
  { key: 'name', label: 'Participant' },
  { key: 'roll_no', label: 'Roll No' },
  { key: 'subject_id', label: 'Subject ID' },
  { key: 'age', label: 'Age', num: true },
  { key: 'gender', label: 'Gender' },
  { key: 'diet', label: 'Diet' },
  { key: 'captures', label: 'Captures', num: true },
  { key: 'faces', label: 'Face detected', num: true },
  { key: 'dominant', label: 'Most frequent emotion' },
  { key: 'valence', label: 'Mean valence', num: true },
  { key: 'arousal', label: 'Mean arousal', num: true },
  { key: 'confidence', label: 'Mean confidence', num: true },
  { key: 'last', label: 'Last capture', num: true },
];

function renderParticipants(rows) {
  const table = $('participantsTable');
  const getters = Object.fromEntries(PARTICIPANT_COLUMNS.map((c) => [c.key, (r) => r[c.key]]));
  const sorted = sortRows(participantRows(rows), state.sort.participants, getters);
  table.className = 'data-table sortable clickable';
  table.innerHTML = tableHead(PARTICIPANT_COLUMNS, state.sort.participants) + `<tbody>${sorted.map((p) => `
    <tr data-search="${esc(p.subject_id || p.name)}">
      <td>${esc(p.name)}</td><td>${esc(p.roll_no || '—')}</td><td class="mono" title="${esc(p.subject_id)}">${esc(shortId(p.subject_id))}</td><td class="num">${esc(p.age ?? '—')}</td>
      <td>${esc(p.gender || '—')}</td><td>${esc(p.diet ?? '—')}</td><td class="num">${p.captures}</td><td class="num">${p.faces}</td><td>${emoChip(p.dominant)}</td>
      <td class="num">${fmtSigned(p.valence)}</td><td class="num">${fmtSigned(p.arousal)}</td><td class="num">${fmtPct(p.confidence)}</td>
      <td class="num">${esc(fmtDateTime(new Date(p.last).toISOString()))}</td>
    </tr>`).join('')}</tbody>`;
  bindSort(table, 'participants', () => renderParticipants(filtered()));
  table.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    $('fSearch').value = tr.dataset.search;
    selectTab('captures');
  }));
}

// ---------- Detail dialog ----------

const REJECTED_COLUMNS = [
  { key: 'created_at', label: 'When', get: (c) => c.time.getTime() },
  { key: 'name', label: 'Participant', get: (c) => c.name || '' },
  { key: 'media_type', label: 'Media', get: (c) => c.media_type },
  { key: 'capture_mode', label: 'Capture app', get: (c) => modeLabel(c.capture_mode) },
  { key: 'reason', label: 'Reason', get: (c) => REASON_BY_KEY[c.reason].label },
  { key: 'message', label: 'Server message', get: (c) => c.message || '' },
];

function renderRejected(rejected, total) {
  $('rejectedSub').textContent = `${rejected.length} of ${total} captures produced no result (${fmtPct(total ? rejected.length / total : NaN)}). Emotion, confidence and face filters don't apply here.`;
  const present = REJECT_REASONS.filter((r) => rejected.some((c) => c.reason === r.key));
  const count = (r) => rejected.filter((c) => c.reason === r.key).length;
  barChart($('chartRejected'), present.map((r) => ({
    label: r.short,
    value: count(r),
    color: r.color,
    tip: tipHtml(esc(r.label), [['Captures', count(r)], ['Share of rejected', fmtPct(count(r) / rejected.length)]]),
  })), { format: (row) => `${row.value} · ${fmtPct(row.value / rejected.length)}`, label: 'Rejected captures by reason' });
  $('rejectedReasons').innerHTML = present.map((r) => `
    <div><dt><span class="emo-chip" style="--chip:${r.color}">${esc(r.label)}</span> <span class="muted">${count(r)}</span></dt><dd>${esc(r.hint)}</dd></div>`).join('');

  const table = $('rejectedTable');
  const getters = Object.fromEntries(REJECTED_COLUMNS.map((c) => [c.key, c.get]));
  const sorted = sortRows(rejected, state.sort.rejected, getters);
  table.innerHTML = tableHead(REJECTED_COLUMNS, state.sort.rejected) + `<tbody>${sorted.map((c) => {
    const r = REASON_BY_KEY[c.reason];
    return `
    <tr data-id="${esc(c.capture_id)}" class="${state.excluded.has(c.capture_id) ? 'excluded' : ''}">
      <td>${esc(fmtDateTime(c.created_at))}</td><td>${esc(c.name)}</td><td>${mediaLabel(c.media_type)}</td><td>${esc(modeLabel(c.capture_mode))}</td>
      <td><span class="emo-chip" style="--chip:${r.color}">${esc(r.label)}</span></td><td class="msg">${esc(c.message || '—')}</td>
    </tr>`;
  }).join('')}</tbody>`;
  bindSort(table, 'rejected', render);
  const byId = new Map(rejected.map((c) => [c.capture_id, c]));
  table.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => openDetail(byId.get(tr.dataset.id))));
}

function openDetail(c) {
  if (!c) return;
  state.detail = c;
  const media = $('detailMedia');
  if (!c.media_url) {
    media.innerHTML = '<p class="chart-empty">No stored media for this capture.</p>';
  } else if (c.media_type === 'video') {
    media.innerHTML = `<video src="${esc(c.media_url)}" controls playsinline preload="metadata"></video>`;
  } else {
    media.innerHTML = `<img src="${esc(c.media_url)}" alt="Captured photo of ${esc(c.name)}" />`;
  }
  $('detailKind').textContent = `${mediaLabel(c.media_type)} capture`;
  $('detailTitle').innerHTML = outcomeChip(c);
  const facts = [
    ['Participant', c.name],
    ['Roll No', c.roll_no || '—'],
    ['Age · gender · diet', `${c.age ?? '—'} · ${c.gender || '—'} · ${c.diet ?? '—'}`],
    ['Captured', fmtDateTime(c.created_at)],
    ['Capture app', modeLabel(c.capture_mode)],
    ['Confidence', hasFace(c) ? fmtPct(c.confidence, 1) : '—'],
    ['Valence', fmtSigned(c.valence, 3)],
    ['Arousal', fmtSigned(c.arousal, 3)],
    ['Subject ID', c.subject_id],
    ['Capture ID', c.capture_id],
    ['Original file', c.original_filename || '—'],
  ];
  if (c.media_type === 'video') facts.splice(8, 0, ['Frames with face', String(c.frameCount)]);
  if (c.outcome === 'rejected') facts.unshift(['Rejected because', REASON_BY_KEY[c.reason].label]);
  $('detailFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('detailExclude').checked = state.excluded.has(c.capture_id);
  $('detailMessage').textContent = c.outcome === 'rejected'
    ? `Server message: “${c.message || 'none'}” ${REASON_BY_KEY[c.reason].hint}`
    : c.message || '';

  const frames = c.frames || [];
  $('detailFramesBlock').hidden = frames.length === 0;
  const isVideo = c.media_type === 'video';
  $('chartFrames').hidden = !isVideo;
  $('legendFrames').hidden = !isVideo;
  $('framesTable').innerHTML = `
    <thead><tr><th>${isVideo ? 'Time' : 'Face'}</th><th>Emotion</th><th class="num">Confidence</th><th class="num">Valence</th><th class="num">Arousal</th></tr></thead>
    <tbody>${frames.map((f, i) => `<tr><td class="num">${isVideo ? `${fmtNum(f.timestamp, 2)}s` : i + 1}</td><td>${emoChip(f.emotion)}</td>
      <td class="num">${fmtPct(f.confidence, 1)}</td><td class="num">${fmtSigned(f.valence, 3)}</td><td class="num">${fmtSigned(f.arousal, 3)}</td></tr>`).join('')}</tbody>`;

  const dialog = $('detailDialog');
  if (!dialog.open) dialog.showModal();
  if (isVideo && frames.length) framesChart($('chartFrames'), frames);
}

$('detailClose').addEventListener('click', () => $('detailDialog').close());
$('detailDialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$('detailDialog').addEventListener('close', () => {
  const video = $('detailMedia').querySelector('video');
  if (video) video.pause();
  state.detail = null;
});
$('detailExclude').addEventListener('change', (e) => {
  if (!state.detail) return;
  if (e.target.checked) state.excluded.add(state.detail.capture_id);
  else state.excluded.delete(state.detail.capture_id);
  localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...state.excluded]));
  render();
});

// ---------- CSV export ----------

function csvCell(value) {
  if (value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))) return '';
  let s = String(value);
  // Neutralise spreadsheet formulas in free-text fields such as participant names.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, header, rows) {
  const text = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

$('csvBtn').addEventListener('click', () => {
  const rows = filtered();
  downloadCsv(`captures_${stamp()}.csv`,
    ['created_at_utc', 'capture_id', 'subject_id', 'name', 'age', 'diet', 'media_type', 'emotion', 'confidence', 'valence', 'arousal',
      'frames_with_face', 'valence_sd_frames', 'arousal_sd_frames', 'excluded', 'media_url',
      'outcome', 'reject_reason', 'message', 'capture_mode'],
    rows.map((c) => [c.created_at, c.capture_id, c.subject_id, c.name, c.age, c.diet, c.media_type, c.emotion, c.confidence, c.valence, c.arousal,
      c.frameCount, c.valenceSd, c.arousalSd, state.excluded.has(c.capture_id) ? 1 : 0, c.media_url ? new URL(c.media_url, location.origin).href : '',
      c.outcome, c.reason ? REASON_BY_KEY[c.reason].label : '', c.message, c.capture_mode]));
});

$('framesCsvBtn').addEventListener('click', () => {
  const rows = filtered().flatMap((c) => c.frames.map((f, i) => [
    c.capture_id, c.subject_id, c.name, c.age, c.diet, c.media_type, i + 1, f.timestamp, f.emotion, f.confidence, f.valence, f.arousal,
  ]));
  downloadCsv(`frames_${stamp()}.csv`,
    ['capture_id', 'subject_id', 'name', 'age', 'diet', 'media_type', 'index', 'timestamp_s', 'emotion', 'confidence', 'valence', 'arousal'], rows);
});

// ---------- Tabs & rendering ----------

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  render();
}

function render() {
  hideTip();
  const rows = filtered();
  renderRangeNote(rows.length);
  renderKpis(rows);
  const unfiltered = filtered({ resultFilters: false });
  const rejected = unfiltered.filter((c) => c.outcome === 'rejected');
  $('rejectedCount').textContent = rejected.length ? ` (${rejected.length})` : '';
  const tabRows = state.tab === 'rejected' ? rejected : rows;
  $('emptyState').hidden = tabRows.length > 0 || !state.captures.length;
  $('emptyTitle').textContent = state.tab === 'rejected'
    ? 'No rejected captures here. Every capture matching these filters produced a result.'
    : 'No captures match these filters.';
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.hidden = p.dataset.panel !== state.tab || !tabRows.length;
  });
  if (state.tab === 'rejected') {
    if (rejected.length) renderRejected(rejected, unfiltered.length);
    return;
  }
  if (!rows.length) return;
  if (state.tab === 'overview') renderOverview(rows);
  if (state.tab === 'explorer') renderExplorer(rows);
  if (state.tab === 'diet') renderDiet(rows);
  if (state.tab === 'compare') renderCompare(rows);
  if (state.tab === 'captures') renderCaptures(rows);
  if (state.tab === 'participants') renderParticipants(rows);
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

for (const id of RANGE_IDS) {
  $(id).addEventListener('change', () => {
    markPreset(null);
    render();
  });
}
document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.range)));

for (const id of ['fMedia', 'fDiet', 'fEmotion', 'fFaceOnly', 'fShowExcluded', 'cGroup', 'cBand', 'cMetric', 'dView', 'dUnit', 'dMetric', 'xVar', 'yVar', 'xFit']) {
  $(id).addEventListener('change', render);
}
$('xUnit').addEventListener('change', () => {
  state.hiddenExplorer.clear();
  setupExplorerControls();
  render();
});
$('xColor').addEventListener('change', () => {
  state.hiddenExplorer.clear();
  render();
});

let inputTimer;
for (const id of ['fAgeMin', 'fAgeMax', 'fMinConf', 'fSearch']) {
  $(id).addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(render, 200);
  });
}

$('resetBtn').addEventListener('click', () => {
  markPreset(null);
  for (const id of [...RANGE_IDS, 'fMedia', 'fDiet', 'fAgeMin', 'fAgeMax', 'fEmotion', 'fMinConf', 'fSearch']) $(id).value = '';
  $('fFaceOnly').checked = false;
  $('fShowExcluded').checked = false;
  state.hiddenMood.clear();
  state.hiddenExplorer.clear();
  render();
});

$('refreshBtn').addEventListener('click', load);

let resizeTimer;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    render();
    if (state.detail && state.detail.media_type === 'video') framesChart($('chartFrames'), state.detail.frames);
  }, 150);
});

setupExplorerControls();
load();
