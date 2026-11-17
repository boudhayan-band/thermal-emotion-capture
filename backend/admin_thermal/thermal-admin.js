// Thermal section of the admin dashboard (/admin/thermal/): every thermal reading, the region temperatures,
// derived indicators, and how they relate to the emotion predicted from the RGB capture taken with them.
// Formatting, statistics and chart helpers below are copied from /admin/admin.js so both sections match.

const $ = (id) => document.getElementById(id);

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
  'No RGB': '#b4bac4',
};
const SVG_NS = 'http://www.w3.org/2000/svg';

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


// ---------- Legend ----------

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

// ---------- Thermal: data ----------

const QUALITY = {
  good: { label: 'Good', color: '#1f9d61', hint: 'Temperature map, face found, at most 12 of 68 landmarks occluded.' },
  fair: { label: 'Fair', color: '#e2a400', hint: '13–34 landmarks occluded: glasses, hair, a hand or a turned head. Region values may be off.' },
  poor: { label: 'Poor', color: '#e5484d', hint: 'No face found (whole frame analysed) or more than half the landmarks occluded.' },
  no_temperature: { label: 'No temperature', color: '#7a8699', hint: 'Only a thermal image was uploaded, so no temperatures were measured. Landmarks only.' },
};
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#8e5cd9', '#e0559b', '#c58a00', '#3f9b4e', '#e5484d', '#0f9fb4', '#7a8699'];
const REGION_KEYS = [
  'face', 'forehead', 'right_inner_canthus', 'left_inner_canthus', 'right_periorbital', 'left_periorbital',
  'nose', 'nose_tip', 'right_cheek', 'left_cheek', 'mouth', 'chin',
];
const DERIVED_METRICS = [
  ['canthus_max_c', 'Inner eye corner (max)'],
  ['face_mean_c', 'Whole face mean'],
  ['face_max_c', 'Whole face max'],
  ['forehead_mean_c', 'Forehead mean'],
  ['periorbital_mean_c', 'Eye area mean'],
  ['nose_tip_c', 'Nose tip'],
  ['nose_forehead_delta_c', 'Nose tip − forehead'],
  ['canthus_asymmetry_c', 'Eye-corner asymmetry (R − L)'],
  ['cheek_asymmetry_c', 'Cheek asymmetry (R − L)'],
];
const DELTA_METRICS = new Set(['nose_forehead_delta_c', 'canthus_asymmetry_c', 'cheek_asymmetry_c']);

const state = {
  captures: [],
  regionLabels: {},
  elevated: 37.5,
  tab: 'overview',
  sort: {
    readings: { key: 'created_at', dir: -1 },
    participants: { key: 'last', dir: -1 },
  },
  hiddenTimeline: new Set(),
  detail: null,
};

// metric key -> { label, get(capture), getFrame(frame), delta }
const METRICS = {};

function buildMetrics() {
  for (const [key, label] of DERIVED_METRICS) {
    METRICS[key] = {
      label,
      delta: DELTA_METRICS.has(key),
      get: (c) => (c.derived || {})[key],
      getFrame: (f) => (f.derived || {})[key],
    };
  }
  for (const key of REGION_KEYS) {
    const label = state.regionLabels[key] || key;
    const pick = (regions) => {
      const r = (regions || {})[key];
      return r && r.mean_c != null && (r.occluded_fraction ?? 0) < 0.5 ? r.mean_c : null;
    };
    METRICS[`region:${key}`] = { label: `${label} (region mean)`, get: (c) => pick(c.regions), getFrame: (f) => pick(f.regions) };
  }
  METRICS.occluded_count = { label: 'Occluded landmarks', unit: '', get: (c) => c.occluded_count, getFrame: (f) => f.occluded_count };
}

const metricVal = (key, c) => {
  const v = METRICS[key].get(c);
  return isNum(v) ? v : null;
};
const unitOf = (key) => (METRICS[key].unit ?? ' °C');
const fmtMetric = (key, v, d = 2) => (!isNum(v) ? '—' : `${METRICS[key].delta ? fmtSigned(v, d) : v.toFixed(d)}${unitOf(key)}`);
const fmtC = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—');
const qualityChip = (q) => (q ? `<span class="q-chip q-${q}">${esc((QUALITY[q] || {}).label || q)}</span>` : '—');
const hasEmotionResult = (c) => Boolean(c.emotion && c.emotion !== 'Unknown' && isNum(c.valence) && isNum(c.arousal));
const modeText = (c) => (c.capture_mode === 'video' ? `Video ${c.duration_sec ? `${c.duration_sec} s` : ''}`.trim() : 'Photo');

async function load() {
  $('loadedAt').textContent = 'Loading…';
  try {
    const response = await fetch('/admin/thermal/data', { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    state.regionLabels = data.regions || {};
    state.elevated = data.elevated_canthus_c || 37.5;
    state.captures = (data.captures || []).map((c) => ({ ...c, time: new Date(c.created_at) }));
    buildMetrics();
    populateControls();
    $('loadedAt').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (err) {
    $('loadedAt').textContent = `Could not load data: ${err.message}`;
  }
  render();
}

function populateControls() {
  const emotions = [...new Set(state.captures.map((c) => c.emotion).filter(Boolean))].sort();
  const fe = $('fEmotion');
  const keep = fe.value;
  fe.innerHTML = '<option value="">All</option>' + emotions.map((e) => `<option>${esc(e)}</option>`).join('');
  fe.value = emotions.includes(keep) ? keep : '';
  const metricOptions = Object.entries(METRICS).filter(([k]) => k !== 'occluded_count')
    .map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join('');
  for (const [id, def] of [['eMetric', 'nose_forehead_delta_c'], ['gMetric', 'canthus_max_c'], ['vMetric', 'canthus_max_c']]) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = metricOptions + (id === 'gMetric' ? '<option value="occluded_count">Occluded landmarks</option>' : '');
    sel.value = prev && METRICS[prev] ? prev : def;
  }
}

// ---------- Filters ----------

const pad2 = (n) => String(n).padStart(2, '0');
const toDateValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function applyPreset(key) {
  const now = new Date();
  if (key === 'all') { $('fFromDate').value = ''; $('fToDate').value = ''; }
  if (key === 'today') { $('fFromDate').value = toDateValue(now); $('fToDate').value = toDateValue(now); }
  if (key === '7d') { $('fFromDate').value = toDateValue(new Date(now - 6 * 864e5)); $('fToDate').value = toDateValue(now); }
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('is-active', b.dataset.range === key));
  render();
}

function filtered({ quality = true } = {}) {
  const from = $('fFromDate').value ? new Date(`${$('fFromDate').value}T00:00:00`) : null;
  const to = $('fToDate').value ? new Date(`${$('fToDate').value}T23:59:59.999`) : null;
  const mode = $('fMode').value;
  const page = $('fPage').value;
  const rgbSource = $('fSource').value;
  const diet = $('fDiet').value;
  const gender = $('fGender').value;
  const emotion = $('fEmotion').value;
  const q = $('fQuality').value;
  const search = $('fSearch').value.trim().toLowerCase();
  return state.captures.filter((c) => {
    if (from && c.time < from) return false;
    if (to && c.time > to) return false;
    if (mode && c.capture_mode !== mode) return false;
    if (page && c.page !== page) return false;
    if (rgbSource && c.rgb_source !== rgbSource) return false;
    if (diet && c.diet !== diet) return false;
    if (gender && c.gender !== gender) return false;
    if (emotion && c.emotion !== emotion) return false;
    if (quality && q === 'usable' && !['good', 'fair'].includes(c.derived.quality)) return false;
    if (quality && q === 'good' && c.derived.quality !== 'good') return false;
    if (search && !`${c.name || ''} ${c.subject_id || ''}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

// ---------- KPIs ----------

function renderKpis(rows) {
  const subjects = new Set(rows.map((c) => c.subject_id));
  const videos = rows.filter((c) => c.capture_mode === 'video').length;
  const withTemp = rows.filter((c) => c.has_temperature);
  const canthus = rows.map((c) => metricVal('canthus_max_c', c)).filter(isNum);
  const face = rows.map((c) => metricVal('face_mean_c', c)).filter(isNum);
  const nf = rows.map((c) => metricVal('nose_forehead_delta_c', c)).filter(isNum);
  const elevated = rows.filter((c) => c.derived.elevated_temp).length;
  const emo = rows.filter(hasEmotionResult).length;
  const tiles = [
    ['Thermal readings', rows.length, `${rows.length - videos} photos · ${videos} videos`],
    ['Participants', subjects.size, `${(rows.length / Math.max(subjects.size, 1)).toFixed(1)} readings each`],
    ['With temperatures', fmtPct(rows.length ? withTemp.length / rows.length : NaN), `${withTemp.length} temperature maps`],
    ['Inner eye corner', isNum(mean(canthus)) ? `${mean(canthus).toFixed(2)} °C` : '—', canthus.length > 1 ? `SD ${sd(canthus).toFixed(2)} · range ${Math.min(...canthus).toFixed(1)}–${Math.max(...canthus).toFixed(1)}` : 'warmest eye corner, mean'],
    ['Elevated', elevated, `inner eye corner ≥ ${state.elevated} °C`],
    ['Whole face', isNum(mean(face)) ? `${mean(face).toFixed(2)} °C` : '—', 'mean over the face'],
    ['Nose − forehead', isNum(mean(nf)) ? `${fmtSigned(mean(nf))} °C` : '—', 'more negative often means more aroused'],
    ['Emotion detected', fmtPct(rows.length ? emo / rows.length : NaN), `${emo} with a face in the RGB capture`],
  ];
  $('kpis').innerHTML = tiles.map(([label, value, note]) => `
    <div class="kpi"><span class="kpi-label">${esc(label)}</span><span class="kpi-value">${esc(value)}</span><span class="kpi-note">${esc(note)}</span></div>`).join('');
}

// ---------- Generic charts ----------

// Enough decimals that neighbouring axis ticks never print the same label.
function tickFormat(domain, signedValues = false) {
  const span = Math.abs(domain[1] - domain[0]);
  const dec = span < 0.5 ? 2 : span < 5 ? 1 : 0;
  return (v) => (signedValues ? fmtSigned(v, dec) : fmtNum(v, dec));
}

function groupStats(groups) {
  return groups.map((g) => ({ ...g, ...describe(g.values) })).filter((g) => g.n > 0);
}

function ciDomain(groups, { includeZero = false } = {}) {
  const vals = groups.flatMap((g) => [g.mean, isNum(g.lo) ? g.lo : g.mean, isNum(g.hi) ? g.hi : g.mean]);
  if (includeZero) vals.push(0);
  return niceDomain(vals, 0.08);
}

function ciGroupsChart(container, groups, metricKey, opts = {}) {
  const stats = groupStats(groups);
  if (!stats.length) return emptyChart(container);
  const domain = ciDomain(stats, opts);
  const fmt = tickFormat(domain, Boolean(opts.includeZero || (METRICS[metricKey] && METRICS[metricKey].delta)));
  ciChart(container, stats.map((g) => ({
    ...g,
    tip: tipHtml(esc(g.label), [
      ['n', String(g.n)],
      ['Mean', fmtMetric(metricKey, g.mean)],
      ['95% CI', g.n >= 2 ? `${fmtNum(g.lo, 2)} to ${fmtNum(g.hi, 2)}` : 'needs n ≥ 2'],
      ['SD', fmtNum(g.sd, 2)],
      ['Range', `${fmtNum(g.min, 1)} – ${fmtNum(g.max, 1)}`],
    ]),
  })), { domain, metricLabel: opts.metricLabel || METRICS[metricKey].label, format: fmt });
  return stats;
}

function histChart(container, values, { step = 0.25, threshold = null, label = 'Histogram', unit = '°C' } = {}) {
  if (!values.length) return emptyChart(container, 'No temperature readings in this selection.');
  const width = chartWidth(container);
  const height = 240;
  const m = { top: 16, right: 16, bottom: 40, left: 40 };
  let lo = Math.floor(Math.min(...values) / step) * step;
  let hi = Math.ceil(Math.max(...values) / step) * step;
  if (threshold != null) { lo = Math.min(lo, threshold - step); hi = Math.max(hi, threshold + step); }
  if (hi - lo < step * 4) { lo -= step * 2; hi += step * 2; }
  const nb = Math.round((hi - lo) / step);
  const counts = new Array(nb).fill(0);
  for (const v of values) counts[Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / step)))] += 1;
  const maxC = Math.max(...counts, 1);
  const x = scale(lo, hi, m.left, width - m.right);
  const y = scale(0, maxC, height - m.bottom, m.top);
  const svg = makeSvg(container, width, height, label);
  for (const t of niceTicks(0, maxC, 4).filter((t) => Number.isInteger(t))) {
    el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'grid' }, svg);
    el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, String(t));
  }
  for (const t of niceTicks(lo, hi, 6)) {
    el('text', { x: x(t), y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, t.toFixed(1));
  }
  el('line', { x1: m.left, x2: width - m.right, y1: height - m.bottom, y2: height - m.bottom, class: 'axis' }, svg);
  el('text', { x: (m.left + width - m.right) / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-title' }, svg, unit);
  counts.forEach((cnt, i) => {
    if (!cnt) return;
    const x0 = x(lo + i * step) + 1;
    const w = Math.max(1, x(lo + (i + 1) * step) - x(lo + i * step) - 2);
    const hot = threshold != null && lo + i * step >= threshold;
    el('path', { d: vBarPath(x0, y(0), w, y(0) - y(cnt), 3), fill: hot ? cssVar('--danger') : cssVar('--series-1'), class: 'bar' }, svg);
    const hit = el('rect', { x: x0, y: m.top, width: w, height: height - m.top - m.bottom, class: 'hit' }, svg);
    bindTip(hit, tipHtml(`${(lo + i * step).toFixed(2)} – ${(lo + (i + 1) * step).toFixed(2)} ${unit}`, [['Readings', String(cnt)]]));
  });
  if (threshold != null) {
    el('line', { x1: x(threshold), x2: x(threshold), y1: m.top, y2: height - m.bottom, class: 'threshold' }, svg);
    el('text', { x: x(threshold) + 4, y: m.top + 10, class: 'threshold-label' }, svg, `${threshold} °C`);
  }
}

// Lines over time. lines: [{ key, label, color, points: [[t, v]], dashed, right, onClick }]
function linesChart(container, lines, { xMax, yLabel = '°C', yFormat = null, rightAxis = false, label = 'Line chart' } = {}) {
  const left = lines.filter((l) => !l.right && l.points.length);
  const right = lines.filter((l) => l.right && l.points.length);
  if (!left.length && !right.length) return emptyChart(container, 'No readings over time in this selection.');
  const width = chartWidth(container);
  const height = 300;
  const m = { top: 12, right: rightAxis ? 44 : 16, bottom: 40, left: 52 };
  const tMax = xMax || Math.max(1, ...lines.flatMap((l) => l.points.map((p) => p[0])));
  const vals = left.flatMap((l) => l.points.map((p) => p[1]));
  const yDomain = vals.length ? niceDomain(vals.length > 1 ? vals : [vals[0] - 0.5, vals[0] + 0.5], 0.08) : [0, 1];
  if (yFormat === null) yFormat = tickFormat(yDomain);
  const x = scale(0, tMax, m.left, width - m.right);
  const y = scale(yDomain[0], yDomain[1], height - m.bottom, m.top);
  const ya = scale(-1, 1, height - m.bottom, m.top);
  const svg = makeSvg(container, width, height, label);
  for (const t of niceTicks(...yDomain)) {
    el('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: 'grid' }, svg);
    el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, yFormat(t));
  }
  for (const t of niceTicks(0, tMax, 6)) {
    el('text', { x: x(t), y: height - m.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, svg, `${t}s`);
  }
  el('line', { x1: m.left, x2: width - m.right, y1: height - m.bottom, y2: height - m.bottom, class: 'axis' }, svg);
  el('text', { x: (m.left + width - m.right) / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-title' }, svg, 'Time in clip (s)');
  el('text', { x: 12, y: (m.top + height - m.bottom) / 2, 'text-anchor': 'middle', class: 'axis-title', transform: `rotate(-90 12 ${(m.top + height - m.bottom) / 2})` }, svg, yLabel);
  if (rightAxis) {
    for (const v of [-1, 0, 1]) el('text', { x: width - m.right + 8, y: ya(v) + 4, class: 'tick' }, svg, v > 0 ? '+1' : String(v));
    el('line', { x1: m.left, x2: width - m.right, y1: ya(0), y2: ya(0), class: 'grid dashed' }, svg);
  }
  const path = (pts, sy) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${sy(v).toFixed(1)}`).join('');
  for (const l of [...left, ...right]) {
    const sy = l.right ? ya : y;
    const p = el('path', { d: path(l.points, sy), class: `video-line${l.dashed ? ' dashed' : ''}`, stroke: l.color }, svg);
    if (l.points.length === 1) el('circle', { cx: x(l.points[0][0]), cy: sy(l.points[0][1]), r: 3.5, fill: l.color }, svg);
    if (l.tip || l.onClick) bindTip(p, l.tip || tipHtml(esc(l.label), []), l.onClick);
  }
}

// ---------- Overview ----------

function renderOverview(rows) {
  const temps = rows.filter((c) => c.has_temperature);
  ciGroupsChart($('chartProfile'), REGION_KEYS.map((k) => ({
    label: state.regionLabels[k] || k,
    values: temps.map((c) => metricVal(`region:${k}`, c)).filter(isNum),
  })), 'region:face', { metricLabel: 'Temperature (°C)' });

  const canthus = rows.map((c) => metricVal('canthus_max_c', c)).filter(isNum);
  histChart($('chartCanthus'), canthus, { threshold: state.elevated, label: 'Inner eye corner temperature' });
  $('canthusSub').textContent = `Warmest inner eye corner per reading (n = ${canthus.length}) · dashed line = ${state.elevated} °C elevated threshold`;

  const all = filtered({ quality: false });
  const qCounts = {};
  for (const c of all) qCounts[c.derived.quality] = (qCounts[c.derived.quality] || 0) + 1;
  barChart($('chartQuality'), Object.keys(QUALITY).filter((q) => qCounts[q]).map((q) => ({
    label: QUALITY[q].label, value: qCounts[q], color: QUALITY[q].color,
    tip: tipHtml(QUALITY[q].label, [['Readings', String(qCounts[q])], ['Share', fmtPct(qCounts[q] / all.length)]]),
  })), { format: (r) => `${r.value} · ${fmtPct(r.value / all.length)}`, label: 'Reading quality' });
  $('qualityNotes').innerHTML = Object.entries(QUALITY).map(([, q]) => `<dt>${esc(q.label)}</dt><dd>${esc(q.hint)}</dd>`).join('');

  const counts = {};
  for (const c of rows) counts[c.emotion || 'No RGB'] = (counts[c.emotion || 'No RGB'] || 0) + 1;
  barChart($('chartEmotions'), Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([e, n]) => ({
    label: e, value: n, color: EMOTIONS[e] || EMOTIONS.Unknown,
    tip: tipHtml(esc(e), [['Readings', String(n)], ['Share', fmtPct(n / rows.length)]]),
  })), { format: (r) => String(r.value), label: 'Emotion distribution' });

  renderTimeline(rows);
}

function renderTimeline(rows) {
  const series = [
    { key: 'Inner eye corner', metric: 'canthus_max_c', color: cssVar('--series-2') },
    { key: 'Whole face mean', metric: 'face_mean_c', color: cssVar('--series-1') },
  ];
  const points = [];
  for (const s of series) {
    if (state.hiddenTimeline.has(s.key)) continue;
    for (const c of rows) {
      const v = metricVal(s.metric, c);
      if (!isNum(v)) continue;
      points.push({
        x: c.time.getTime(), y: v, color: s.color, r: 5,
        tip: tipHtml(`${esc(c.name)} · ${esc(s.key)}`, [['When', fmtDateTime(c.created_at)], ['Value', `${v.toFixed(2)} °C`], ['Capture', modeText(c)], ['Emotion', c.emotion || '—']]),
        onClick: () => openDetail(c),
      });
    }
  }
  renderLegend($('legendTimeline'), series.map((s) => ({ key: s.key, color: s.color })), state.hiddenTimeline, (key) => {
    toggleSet(state.hiddenTimeline, key);
    renderTimeline(filtered());
  });
  if (!points.length) return emptyChart($('chartTimeline'), 'No temperature readings in this selection.');
  const xs = points.map((p) => p.x);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x1 - x0 < 60e3) { x0 -= 30 * 60e3; x1 += 30 * 60e3; }
  const span = x1 - x0;
  const fmtX = span > 2 * 864e5
    ? (v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : (v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ticks = Array.from({ length: 5 }, (_, i) => x0 + (span * i) / 4);
  const yDomain = niceDomain(points.length > 1 ? points.map((p) => p.y) : [points[0].y - 0.5, points[0].y + 0.5], 0.1);
  scatterChart($('chartTimeline'), {
    points, xDomain: [x0 - span * 0.03, x1 + span * 0.03], yDomain,
    xLabel: 'When', yLabel: '°C', xFormat: fmtX, xTicks: ticks, yFormat: tickFormat(yDomain), label: 'Readings over time',
  });
}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

// ---------- Thermal x emotion ----------

function renderEmotion(rows) {
  const emoRows = rows.filter((c) => hasEmotionResult(c) && c.has_temperature);
  // Correlation table
  const keys = Object.keys(METRICS);
  const lines = keys.map((key) => {
    const pairs = emoRows.map((c) => [metricVal(key, c), c.valence, c.arousal]).filter((p) => isNum(p[0]));
    const v = pairs.length >= 3 ? pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null;
    const a = pairs.length >= 3 ? pearson(pairs.map((p) => p[0]), pairs.map((p) => p[2])) : null;
    return { key, n: pairs.length, v, a };
  });
  const corrCell = (res) => {
    if (!res || !isNum(res.r)) return '<td class="num">—</td><td class="num">—</td>';
    const strong = isNum(res.p) && res.p < 0.05;
    const color = res.r >= 0 ? cssVar('--series-1') : cssVar('--series-2');
    return `<td class="num corr-cell${strong ? ' corr-strong' : ''}"><span class="corr-bar" style="width:${Math.round(Math.abs(res.r) * 40)}px;background:${color}"></span>${fmtSigned(res.r, 2)}</td>
      <td class="num${strong ? ' corr-strong' : ''}">${fmtP(res.p)}</td>`;
  };
  $('corrTable').innerHTML = `
    <thead><tr><th>Thermal measure</th><th class="num">n</th><th class="num">r with valence</th><th class="num">p</th><th class="num">r with arousal</th><th class="num">p</th></tr></thead>
    <tbody>${lines.map((l) => `<tr data-metric="${l.key}"><td>${esc(METRICS[l.key].label)}</td><td class="num">${l.n}</td>${corrCell(l.v)}${corrCell(l.a)}</tr>`).join('')}</tbody>`;
  $('corrTable').querySelectorAll('tr[data-metric]').forEach((tr) => tr.addEventListener('click', () => {
    $('eMetric').value = tr.dataset.metric;
    renderEmotion(filtered());
  }));
  const sig = lines.flatMap((l) => [['valence', l.v], ['arousal', l.a]].filter(([, r]) => r && isNum(r.p) && r.p < 0.05)
    .map(([what, r]) => `${METRICS[l.key].label} ${r.r > 0 ? 'rises' : 'falls'} with ${what} (r = ${fmtSigned(r.r)}, p = ${fmtP(r.p)})`));
  $('corrNote').textContent = `${emoRows.length} readings have both a temperature map and an emotion result. `
    + (emoRows.length < 10 ? 'That is too few for reliable correlations; treat these as exploratory. ' : '')
    + (sig.length ? `Significant at p < 0.05 (uncorrected for ${lines.length * 2} tests): ${sig.join('; ')}.` : 'No correlation reaches p < 0.05.')
    + ' Click a row to plot it below.';

  // By emotion
  const metric = $('eMetric').value;
  $('emoMetricTitle').textContent = `${METRICS[metric].label} by predicted emotion`;
  const byEmo = {};
  for (const c of emoRows) {
    const v = metricVal(metric, c);
    if (isNum(v)) (byEmo[c.emotion] = byEmo[c.emotion] || []).push(v);
  }
  const groups = Object.entries(byEmo).sort((a, b) => b[1].length - a[1].length).map(([label, values]) => ({ label, values }));
  ciGroupsChart($('chartByEmotion'), groups, metric, { includeZero: METRICS[metric].delta });
  const testable = groups.filter((g) => g.values.length >= 2);
  if (testable.length >= 2) {
    const res = anova(testable.map((g) => g.values));
    $('emotionTest').innerHTML = `<span>One-way ANOVA across ${testable.length} emotions: <strong>F(${res.d1}, ${res.d2}) = ${fmtNum(res.f, 2)}</strong>, p = <strong>${fmtP(res.p)}</strong>, η² = ${fmtNum(res.eta2, 3)}</span>`;
  } else {
    $('emotionTest').innerHTML = '<span class="muted">Needs at least two emotions with 2 or more readings each for a test.</span>';
  }

  // Scatter vs valence / arousal
  for (const [axis, chartId, statId, titleId] of [['valence', 'chartVsValence', 'statValence', 'vTitle'], ['arousal', 'chartVsArousal', 'statArousal', 'aTitle']]) {
    $(titleId).textContent = `${METRICS[metric].label} vs ${axis}`;
    const pts = emoRows.map((c) => ({ c, x: c[axis], y: metricVal(metric, c) })).filter((p) => isNum(p.y));
    const yDom = pts.length > 1 ? niceDomain(pts.map((p) => p.y), 0.1) : pts.length ? [pts[0].y - 0.5, pts[0].y + 0.5] : [0, 1];
    const fit = pts.length >= 3 ? pearson(pts.map((p) => p.x), pts.map((p) => p.y)) : null;
    scatterChart($(chartId), {
      points: pts.map((p) => ({
        x: p.x, y: p.y, color: EMOTIONS[p.c.emotion] || EMOTIONS.Unknown,
        tip: tipHtml(`${esc(p.c.name)} · ${esc(p.c.emotion)}`, [[axis, fmtSigned(p.x)], [METRICS[metric].label, fmtMetric(metric, p.y)], ['When', fmtDateTime(p.c.created_at)]]),
        onClick: () => openDetail(p.c),
      })),
      xDomain: [-1, 1], yDomain: yDom, yFormat: tickFormat(yDom, METRICS[metric].delta),
      xLabel: axis === 'valence' ? 'Valence (unpleasant → pleasant)' : 'Arousal (calm → energized)', yLabel: METRICS[metric].label,
      fit: fit && isNum(fit.slope) ? fit : null, xFormat: (v) => fmtSigned(v, 1), label: `${METRICS[metric].label} vs ${axis}`,
    });
    $(statId).innerHTML = fit && isNum(fit.r)
      ? `<span>Pearson <strong>r = ${fmtSigned(fit.r)}</strong>, p = <strong>${fmtP(fit.p)}</strong>, n = ${fit.n}</span><span>Slope ${fmtNum(fit.slope, 2)} °C per unit ${axis}</span>`
      : '<span class="muted">Needs at least 3 readings.</span>';
  }
}

// ---------- Groups ----------

function groupOf(c, by) {
  switch (by) {
    case 'age_band': {
      if (!isNum(c.age)) return 'Unknown age';
      const lo = Math.floor(c.age / 10) * 10;
      return `${lo}–${lo + 9}`;
    }
    case 'capture_mode': return c.capture_mode === 'video' ? 'Video' : 'Photo';
    case 'subject': return c.name || c.subject_id;
    case 'emotion': return c.emotion || 'No RGB';
    case 'rgb_source': return sourceText(c);
    default: return c[by] || 'Unknown';
  }
}

function sourceText(c) {
  return c.rgb_source === 'mobile' ? 'Phone' : 'Laptop';
}

function renderGroups(rows) {
  const by = $('gGroup').value;
  const metric = $('gMetric').value;
  const buckets = {};
  for (const c of rows) {
    const v = metricVal(metric, c);
    if (!isNum(v)) continue;
    (buckets[groupOf(c, by)] = buckets[groupOf(c, by)] || []).push(v);
  }
  const groups = Object.entries(buckets).sort((a, b) => (by === 'age_band' ? a[0].localeCompare(b[0], undefined, { numeric: true }) : b[1].length - a[1].length))
    .map(([label, values]) => ({ label, values }));
  const stats = ciGroupsChart($('chartGroups'), groups, metric, { includeZero: METRICS[metric].delta }) || [];
  const testable = groups.filter((g) => g.values.length >= 2);
  let test = '<span class="muted">Needs at least two groups with 2 or more readings each for a test.</span>';
  if (testable.length === 2) {
    const r = welch(testable[0].values, testable[1].values);
    test = `<span>Welch t-test, ${esc(testable[0].label)} vs ${esc(testable[1].label)}: <strong>t(${fmtNum(r.df, 1)}) = ${fmtNum(r.t, 2)}</strong>, p = <strong>${fmtP(r.p)}</strong></span>
      <span>Difference ${fmtSigned(mean(testable[0].values) - mean(testable[1].values))} °C · Cohen's d = ${fmtNum(r.d, 2)}</span>`;
  } else if (testable.length > 2) {
    const r = anova(testable.map((g) => g.values));
    test = `<span>One-way ANOVA across ${testable.length} groups: <strong>F(${r.d1}, ${r.d2}) = ${fmtNum(r.f, 2)}</strong>, p = <strong>${fmtP(r.p)}</strong>, η² = ${fmtNum(r.eta2, 3)}</span>`;
  }
  $('groupTest').innerHTML = test;
  $('groupTable').innerHTML = `
    <thead><tr><th>Group</th><th class="num">n</th><th class="num">Mean</th><th class="num">95% CI</th><th class="num">SD</th><th class="num">Median</th><th class="num">Min</th><th class="num">Max</th></tr></thead>
    <tbody>${stats.map((g) => `<tr><td>${esc(g.label)}</td><td class="num">${g.n}</td><td class="num">${fmtMetric(metric, g.mean)}</td>
      <td class="num">${g.n >= 2 ? `${fmtNum(g.lo, 2)} to ${fmtNum(g.hi, 2)}` : '—'}</td><td class="num">${fmtNum(g.sd, 2)}</td>
      <td class="num">${fmtNum(g.median, 2)}</td><td class="num">${fmtNum(g.min, 2)}</td><td class="num">${fmtNum(g.max, 2)}</td></tr>`).join('')}</tbody>`;
}

// ---------- Videos ----------

function renderVideos(rows) {
  const videos = rows.filter((c) => c.capture_mode === 'video' && (c.thermal_frames || []).length);
  const metric = $('vMetric').value;
  const delta = $('vMode').value === 'delta';
  $('videoSub').textContent = `${videos.length} video${videos.length === 1 ? '' : 's'} · each line is one video · times on the RGB video's clock · click a line to open it`;
  const lines = videos.map((c, i) => {
    const pts = c.thermal_frames.map((f) => [f.t_sync ?? f.t, METRICS[metric].getFrame(f)]).filter((p) => isNum(p[1]) && p[0] >= 0);
    const base = pts.length ? pts[0][1] : 0;
    return {
      key: c.capture_id,
      label: `${c.name} · ${fmtDateTime(c.created_at)}`,
      color: PALETTE[i % PALETTE.length],
      points: delta ? pts.map(([t, v]) => [t, v - base]) : pts,
      tip: tipHtml(`${esc(c.name)} · ${esc(c.emotion || '—')}`, [['When', fmtDateTime(c.created_at)], ['Length', `${c.duration_sec || '—'} s`], ['Samples', String(pts.length)]]),
      onClick: () => openDetail(c),
    };
  });
  linesChart($('chartVideos'), lines, {
    xMax: Math.max(5, ...videos.map((c) => c.duration_sec || 0)),
    yLabel: delta ? `Change in ${METRICS[metric].label} (°C)` : `${METRICS[metric].label}${unitOf(metric)}`,
    yFormat: delta ? (v) => fmtSigned(v, 2) : null, label: 'Thermal measure over the clip',
  });
  renderLegend($('legendVideos'), lines.slice(0, 20).map((l) => ({ key: l.label, color: l.color })));

  ciGroupsChart($('chartSlopes'), REGION_KEYS.map((k) => ({
    label: state.regionLabels[k] || k,
    values: videos.map((c) => ((c.regions || {})[k] || {}).slope_c_per_min).filter(isNum),
  })), 'canthus_asymmetry_c', { includeZero: true, metricLabel: 'Slope (°C/min)' });
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

const d = (key) => (c) => metricVal(key, c);
const READING_COLUMNS = [
  { key: 'created_at', label: 'When', get: (c) => c.time.getTime(), html: (c) => esc(fmtDateTime(c.created_at)) },
  { key: 'name', label: 'Participant', get: (c) => c.name || '', html: (c) => esc(c.name) },
  { key: 'age', label: 'Age', num: true, get: (c) => c.age, html: (c) => esc(c.age ?? '—') },
  { key: 'gender', label: 'Gender', get: (c) => c.gender || '', html: (c) => esc(c.gender || '—') },
  { key: 'diet', label: 'Diet', get: (c) => c.diet || '', html: (c) => esc(c.diet || '—') },
  { key: 'mode', label: 'Capture', get: (c) => modeText(c), html: (c) => esc(modeText(c)) },
  { key: 'rgb_source', label: 'RGB camera', get: (c) => c.rgb_source, html: (c) => esc(sourceText(c)) },
  { key: 'emotion', label: 'Emotion', get: (c) => c.emotion || '', html: (c) => (c.emotion ? emoChip(c.emotion) : '<span class="muted">no RGB</span>') },
  { key: 'valence', label: 'Valence', num: true, get: (c) => c.valence, html: (c) => fmtSigned(c.valence) },
  { key: 'arousal', label: 'Arousal', num: true, get: (c) => c.arousal, html: (c) => fmtSigned(c.arousal) },
  { key: 'canthus', label: 'Eye corner °C', num: true, get: d('canthus_max_c'), html: (c) => `<span class="${c.derived.elevated_temp ? 'flag-hot' : ''}">${fmtC(metricVal('canthus_max_c', c), 2)}</span>` },
  { key: 'face', label: 'Face °C', num: true, get: d('face_mean_c'), html: (c) => fmtC(metricVal('face_mean_c', c), 2) },
  { key: 'forehead', label: 'Forehead °C', num: true, get: d('forehead_mean_c'), html: (c) => fmtC(metricVal('forehead_mean_c', c), 2) },
  { key: 'nose', label: 'Nose tip °C', num: true, get: d('nose_tip_c'), html: (c) => fmtC(metricVal('nose_tip_c', c), 2) },
  { key: 'nf', label: 'Nose − forehead', num: true, get: d('nose_forehead_delta_c'), html: (c) => fmtSigned(metricVal('nose_forehead_delta_c', c)) },
  { key: 'occluded', label: 'Occluded', num: true, get: (c) => c.occluded_count, html: (c) => esc(c.occluded_count ?? '—') },
  { key: 'quality', label: 'Quality', get: (c) => ['good', 'fair', 'poor', 'no_temperature'].indexOf(c.derived.quality), html: (c) => qualityChip(c.derived.quality) },
];

function renderReadings(rows) {
  const table = $('readingsTable');
  const getters = Object.fromEntries(READING_COLUMNS.map((c) => [c.key, c.get]));
  const sorted = sortRows(rows, state.sort.readings, getters);
  $('readingsSub').textContent = `${rows.length} readings · click a row for images, regions, landmarks and the timeline`;
  table.innerHTML = tableHead(READING_COLUMNS, state.sort.readings)
    + `<tbody>${sorted.map((c, i) => `<tr data-i="${i}">${READING_COLUMNS.map((col) => `<td class="${col.num ? 'num' : ''}">${col.html(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  table.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => openDetail(sorted[Number(tr.dataset.i)])));
  bindSort(table, 'readings', () => renderReadings(rows));
}

function renderParticipants(rows) {
  const by = {};
  for (const c of rows) (by[c.subject_id] = by[c.subject_id] || []).push(c);
  const people = Object.values(by).map((list) => {
    const last = list.reduce((a, b) => (a.time > b.time ? a : b));
    const vals = (key) => list.map((c) => metricVal(key, c)).filter(isNum);
    const emo = list.filter(hasEmotionResult);
    return {
      subject_id: last.subject_id, name: last.name, age: last.age, gender: last.gender, diet: last.diet,
      n: list.length, videos: list.filter((c) => c.capture_mode === 'video').length,
      canthus: mean(vals('canthus_max_c')), canthusSd: sd(vals('canthus_max_c')), face: mean(vals('face_mean_c')),
      nf: mean(vals('nose_forehead_delta_c')), valence: mean(emo.map((c) => c.valence)), arousal: mean(emo.map((c) => c.arousal)),
      elevated: list.filter((c) => c.derived.elevated_temp).length, last: last.time.getTime(), lastEmotion: last.emotion,
    };
  });
  const cols = [
    { key: 'name', label: 'Participant', get: (p) => p.name || '', html: (p) => esc(p.name) },
    { key: 'age', label: 'Age', num: true, get: (p) => p.age, html: (p) => esc(p.age ?? '—') },
    { key: 'gender', label: 'Gender', get: (p) => p.gender || '', html: (p) => esc(p.gender || '—') },
    { key: 'diet', label: 'Diet', get: (p) => p.diet || '', html: (p) => esc(p.diet || '—') },
    { key: 'n', label: 'Readings', num: true, get: (p) => p.n, html: (p) => `${p.n}${p.videos ? ` <span class="muted">(${p.videos} video)</span>` : ''}` },
    { key: 'canthus', label: 'Eye corner °C', num: true, get: (p) => p.canthus, html: (p) => `${fmtC(p.canthus, 2)}${isNum(p.canthusSd) ? ` <span class="muted">± ${p.canthusSd.toFixed(2)}</span>` : ''}` },
    { key: 'face', label: 'Face °C', num: true, get: (p) => p.face, html: (p) => fmtC(p.face, 2) },
    { key: 'nf', label: 'Nose − forehead', num: true, get: (p) => p.nf, html: (p) => fmtSigned(p.nf) },
    { key: 'valence', label: 'Valence', num: true, get: (p) => p.valence, html: (p) => fmtSigned(p.valence) },
    { key: 'arousal', label: 'Arousal', num: true, get: (p) => p.arousal, html: (p) => fmtSigned(p.arousal) },
    { key: 'elevated', label: 'Elevated', num: true, get: (p) => p.elevated, html: (p) => (p.elevated ? `<span class="flag-hot">${p.elevated}</span>` : '0') },
    { key: 'last', label: 'Last reading', get: (p) => p.last, html: (p) => esc(fmtDateTime(p.last)) },
  ];
  const table = $('participantsTable');
  const sorted = sortRows(people, state.sort.participants, Object.fromEntries(cols.map((c) => [c.key, c.get])));
  table.innerHTML = tableHead(cols, state.sort.participants)
    + `<tbody>${sorted.map((p, i) => `<tr data-i="${i}">${cols.map((col) => `<td class="${col.num ? 'num' : ''}">${col.html(p)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  table.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    $('fSearch').value = sorted[Number(tr.dataset.i)].subject_id;
    selectTab('readings');
  }));
  bindSort(table, 'participants', () => renderParticipants(rows));
}

// ---------- Detail ----------

function detailTimeline(c) {
  const frames = c.thermal_frames || [];
  const emo = c.emotion_frames || [];
  const defs = [
    ['face_mean_c', 'Face mean', '#eb6834'], ['canthus_max_c', 'Inner eye corner', '#e5484d'],
    ['forehead_mean_c', 'Forehead', '#c58a00'], ['nose_tip_c', 'Nose tip', '#2a78d6'],
  ];
  const lines = defs.map(([key, label, color]) => ({
    key, label, color, points: frames.map((f) => [f.t_sync ?? f.t, (f.derived || {})[key]]).filter((p) => isNum(p[1]) && p[0] >= 0),
  }));
  lines.push({ key: 'valence', label: 'Valence', color: '#1baf7a', right: true, dashed: true, points: emo.map((f) => [f.timestamp, f.valence]).filter((p) => isNum(p[1])) });
  lines.push({ key: 'arousal', label: 'Arousal', color: '#8e5cd9', right: true, dashed: true, points: emo.map((f) => [f.timestamp, f.arousal]).filter((p) => isNum(p[1])) });
  linesChart($('chartDetailTimeline'), lines, { xMax: c.duration_sec || undefined, rightAxis: true, label: 'Temperatures and emotion over the clip' });
  renderLegend($('legendDetailTimeline'), lines.filter((l) => l.points.length).map((l) => ({ key: l.label, color: l.color })));
}

function openDetail(c) {
  if (!c) return;
  state.detail = c;
  const isVideo = c.capture_mode === 'video';
  const media = [];
  if (c.overlay_url) media.push(`<figure><img src="${esc(c.overlay_url)}" alt="Thermal overlay" /><figcaption>Thermal landmarks${isVideo ? ' (representative frame)' : ''} · green visible, red occluded</figcaption></figure>`);
  if (c.thermal_preview_url) media.push(`<figure><video src="${esc(c.thermal_preview_url)}" controls loop muted playsinline preload="metadata"></video><figcaption>Thermal clip</figcaption></figure>`);
  // Made and saved on first request for captures recorded before landmark videos existed (takes a few seconds).
  if (isVideo && c.thermal_url) media.push(`<figure><video src="/admin/thermal/landmark_video/${encodeURIComponent(c.capture_id)}" controls loop muted playsinline preload="metadata"></video><figcaption>Landmarks over the clip · every thermal frame · green visible, red occluded</figcaption></figure>`);
  if (c.rgb_url) {
    media.push(isVideo
      ? `<figure><video src="${esc(c.rgb_url)}" controls loop muted playsinline preload="metadata"></video><figcaption>RGB video</figcaption></figure>`
      : `<figure><img src="${esc(c.rgb_url)}" alt="RGB photo" /><figcaption>RGB photo</figcaption></figure>`);
  }
  $('detailMedia').innerHTML = media.join('') || '<p class="chart-empty">No stored images.</p>';
  $('detailKind').textContent = `${modeText(c)} · ${c.page === 'thermal-sync' ? 'Synced capture page' : 'Thermal page'}`;
  $('detailTitle').innerHTML = `${esc(c.name)} ${c.emotion ? emoChip(c.emotion) : ''} ${qualityChip(c.derived.quality)}`;
  const der = c.derived;
  const frame = c.frame_temp || {};
  const facts = [
    ['Captured', fmtDateTime(c.created_at)],
    ['Age · gender · diet', `${c.age ?? '—'} · ${c.gender || '—'} · ${c.diet || '—'}`],
    ['Source · device', `${c.source || '—'} · ${c.device || '—'}`],
    ['RGB camera', `${sourceText(c)}${c.rgb_device ? ` · ${c.rgb_device}` : ''}${isNum(c.sync_skew_ms) ? ` · RGB−thermal ${fmtSigned(c.sync_skew_ms, 0)} ms` : ''}`],
    ['Emotion', c.emotion ? `${c.emotion} (${fmtPct(c.confidence, 0)})` : 'No RGB'],
    ['Valence · arousal', `${fmtSigned(c.valence)} · ${fmtSigned(c.arousal)}`],
    ['Inner eye corner (max)', `${fmtMetric('canthus_max_c', der.canthus_max_c)}${der.elevated_temp ? ' — elevated' : ''}`],
    ['Whole face mean · max', `${fmtMetric('face_mean_c', der.face_mean_c)} · ${fmtMetric('face_max_c', der.face_max_c)}`],
    ['Nose tip − forehead', fmtMetric('nose_forehead_delta_c', der.nose_forehead_delta_c)],
    ['Eye-corner asymmetry', fmtMetric('canthus_asymmetry_c', der.canthus_asymmetry_c)],
    ['Cheek asymmetry', fmtMetric('cheek_asymmetry_c', der.cheek_asymmetry_c)],
    ['Frame range', isNum(frame.min) ? `${frame.min.toFixed(1)} – ${frame.max.toFixed(1)} °C` : '—'],
    ['Occluded landmarks', `${c.occluded_count ?? '—'} / 68${isVideo ? ' (avg)' : ''}`],
    ['Face box', c.face_box ? `${c.face_box.source.replaceAll('_', ' ')}` : '—'],
  ];
  if (isVideo) facts.push(['Clip', `${c.duration_sec} s · ${(c.thermal_frames || []).length} thermal samples · ${(c.emotion_frames || []).length} emotion frames · sync offset ${fmtNum(c.sync_offset_ms, 0)} ms`]);
  facts.push(['Subject ID', c.subject_id], ['Capture ID', c.capture_id]);
  $('detailFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  const regions = c.regions || {};
  $('detailRegions').innerHTML = `<thead><tr><th>Region</th><th class="num">Mean</th><th class="num">Min</th><th class="num">Max</th>${isVideo ? '<th class="num">SD over clip</th><th class="num">Change</th><th class="num">°C/min</th>' : ''}<th class="num">Occluded</th></tr></thead>
    <tbody>${REGION_KEYS.filter((k) => regions[k]).map((k) => {
      const r = regions[k];
      return `<tr class="${r.occluded_fraction >= 0.5 ? 'muted' : ''}"><td>${esc(r.label)}</td><td class="num">${fmtC(r.mean_c, 2)}</td><td class="num">${fmtC(r.min_c, 2)}</td><td class="num">${fmtC(r.max_c, 2)}</td>
        ${isVideo ? `<td class="num">${fmtNum(r.std_c, 3)}</td><td class="num">${fmtSigned(r.change_c)}</td><td class="num">${fmtSigned(r.slope_c_per_min)}</td>` : ''}
        <td class="num">${fmtPct(r.occluded_fraction)}</td></tr>`;
    }).join('')}</tbody>`;

  $('detailTimelineBlock').hidden = !isVideo;
  $('detailFramesWrap').hidden = !isVideo;
  if (isVideo) {
    const emo = c.emotion_frames || [];
    const near = (t) => {
      let best = null;
      for (const f of emo) if (!best || Math.abs(f.timestamp - t) < Math.abs(best.timestamp - t)) best = f;
      return best && Math.abs(best.timestamp - t) <= 0.3 ? best : null;
    };
    $('detailFrames').innerHTML = `<thead><tr><th class="num">t (s)</th><th class="num">Face</th><th class="num">Eye corner</th><th class="num">Forehead</th><th class="num">Nose tip</th><th class="num">Nose − forehead</th><th class="num">Occluded</th><th>Emotion</th><th class="num">Valence</th><th class="num">Arousal</th></tr></thead>
      <tbody>${(c.thermal_frames || []).map((f, k) => {
        const fd = f.derived || {};
        const e = near(f.t_sync ?? f.t);
        return `<tr data-k="${k}" tabindex="0" title="Show this frame's landmarks"><td class="num">${fmtNum(f.t_sync ?? f.t, 1)}</td><td class="num">${fmtC(fd.face_mean_c, 2)}</td><td class="num">${fmtC(fd.canthus_max_c, 2)}</td>
          <td class="num">${fmtC(fd.forehead_mean_c, 2)}</td><td class="num">${fmtC(fd.nose_tip_c, 2)}</td><td class="num">${fmtSigned(fd.nose_forehead_delta_c)}</td>
          <td class="num">${f.occluded_count}</td><td>${e ? emoChip(e.emotion) : '—'}</td><td class="num">${e ? fmtSigned(e.valence) : '—'}</td><td class="num">${e ? fmtSigned(e.arousal) : '—'}</td></tr>`;
      }).join('')}</tbody>`;
  }
  frameState = { capture: c, frames: null, k: -1 };
  $('detailFrameViewer').hidden = true;
  renderDetailLandmarks(c.landmarks, isVideo ? '· representative frame' : '');
  if (isVideo) {
    $('detailFrames').querySelectorAll('tbody tr').forEach((tr) => {
      const k = Number(tr.dataset.k);
      tr.addEventListener('click', () => selectDetailFrame(k));
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectDetailFrame(k); } });
    });
  }
  $('detailMessage').textContent = [c.thermal_message, c.emotion_message].filter(Boolean).join(' ');
  $('detailLinks').innerHTML = [
    ['rgb_url', isVideo ? 'RGB video' : 'RGB photo'], ['thermal_url', isVideo ? 'Thermal clip (.npz)' : 'Thermal upload'],
    ['temp_map_url', 'Temperature map (.npy)'], ['thermal_preview_url', 'Thermal video'], ['overlay_url', 'Overlay'],
    ['landmark_video_url', 'Landmark video'],
  ].filter(([k]) => c[k]).map(([k, label]) => `<a href="${esc(c[k])}" target="_blank" rel="noopener">${esc(label)} ↗</a>`).join('');

  const dialog = $('detailDialog');
  if (!dialog.open) dialog.showModal();
  if (isVideo) requestAnimationFrame(() => detailTimeline(c));
}

// ---------- Per-frame landmarks (video captures) ----------

let frameState = { capture: null, frames: null, k: -1 };

function renderDetailLandmarks(landmarks, label) {
  $('detailLandmarksSub').textContent = label || '';
  $('detailLandmarks').innerHTML = `<thead><tr><th class="num">#</th><th class="num">x</th><th class="num">y</th><th class="num">°C</th><th class="num">Occlusion</th></tr></thead>
    <tbody>${(landmarks || []).map((l) => `<tr class="${l.occluded ? 'muted' : ''}"><td class="num">${l.index}</td><td class="num">${fmtNum(l.x, 1)}</td><td class="num">${fmtNum(l.y, 1)}</td>
      <td class="num">${fmtC(l.temp_c, 2)}</td><td class="num">${fmtPct(l.occlusion_prob)}${l.occluded ? ' · occluded' : ''}</td></tr>`).join('')}</tbody>`;
}

// Landmarks for every analysed frame come from /admin/thermal/frames/ (fetched once per opened capture;
// older captures are analysed on the first request, which takes a few seconds).
async function loadDetailFrames(c) {
  if (frameState.capture === c && frameState.frames) return frameState.frames;
  if (frameState.capture === c && frameState.loading) return frameState.loading;
  frameState.loading = fetch(`/admin/thermal/frames/${encodeURIComponent(c.capture_id)}`, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((data) => { if (frameState.capture === c) frameState.frames = data.frames; return data.frames; })
    .finally(() => { if (frameState.capture === c) frameState.loading = null; });
  return frameState.loading;
}

async function selectDetailFrame(k) {
  const c = frameState.capture;
  const rows = (c && c.thermal_frames) || [];
  if (!c || k < 0 || k >= rows.length) return;
  frameState.k = k;
  $('detailFrames').querySelectorAll('tbody tr').forEach((tr) => tr.classList.toggle('is-selected', Number(tr.dataset.k) === k));
  const f = rows[k];
  const fd = f.derived || {};
  const t = f.t_sync ?? f.t;
  const caption = `Frame ${k + 1} of ${rows.length} · t = ${fmtNum(t, 1)} s · occluded ${f.occluded_count}/68 · face ${fmtC(fd.face_mean_c, 2)} · eye corner ${fmtC(fd.canthus_max_c, 2)}`;
  $('detailFrameViewer').hidden = false;
  $('detailFramePrev').disabled = k <= 0;
  $('detailFrameNext').disabled = k >= rows.length - 1;
  $('detailFrameCaption').textContent = frameState.frames ? caption : `${caption} · loading landmarks…`;
  let frames;
  try {
    frames = await loadDetailFrames(c);
  } catch (err) {
    if (frameState.capture === c && frameState.k === k) $('detailFrameCaption').textContent = `${caption} · could not load landmarks (${err.message})`;
    return;
  }
  if (frameState.capture !== c || frameState.k !== k) return; // another frame or capture was picked meanwhile
  const lf = frames[k];
  if (!lf) return;
  $('detailFrameImage').src = lf.image_url;
  $('detailFrameCaption').textContent = caption;
  renderDetailLandmarks(lf.landmarks, `· frame at t = ${fmtNum(lf.t_sync, 1)} s`);
}

$('detailFramePrev').addEventListener('click', () => selectDetailFrame(frameState.k - 1));
$('detailFrameNext').addEventListener('click', () => selectDetailFrame(frameState.k + 1));

$('detailClose').addEventListener('click', () => $('detailDialog').close());
$('detailDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('detailDialog').addEventListener('close', () => {
  $('detailMedia').querySelectorAll('video').forEach((v) => v.pause());
  state.detail = null;
  frameState = { capture: null, frames: null, k: -1 };
});

// ---------- CSV ----------

function downloadCsv(name, header, rows) {
  const q = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(q).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${name}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('csvBtn').addEventListener('click', () => {
  const rows = filtered();
  const derivedKeys = DERIVED_METRICS.map(([k]) => k);
  downloadCsv('thermal_readings',
    ['created_at', 'capture_id', 'subject_id', 'name', 'age', 'gender', 'diet', 'page', 'mode', 'duration_sec', 'device',
      'rgb_source', 'rgb_device', 'sync_offset_ms', 'sync_skew_ms', 'emotion', 'confidence', 'valence', 'arousal', 'occluded_count', 'quality', 'elevated_temp', ...derivedKeys,
      ...REGION_KEYS.map((k) => `${k}_mean_c`), ...REGION_KEYS.map((k) => `${k}_slope_c_per_min`)],
    rows.map((c) => [c.created_at, c.capture_id, c.subject_id, c.name, c.age, c.gender, c.diet, c.page, c.capture_mode, c.duration_sec, c.device,
      c.rgb_source, c.rgb_device, c.sync_offset_ms, c.sync_skew_ms, c.emotion, c.confidence, c.valence, c.arousal, c.occluded_count, c.derived.quality, c.derived.elevated_temp,
      ...derivedKeys.map((k) => c.derived[k]), ...REGION_KEYS.map((k) => ((c.regions || {})[k] || {}).mean_c),
      ...REGION_KEYS.map((k) => ((c.regions || {})[k] || {}).slope_c_per_min)]));
});

$('framesCsvBtn').addEventListener('click', () => {
  const rows = filtered().filter((c) => c.capture_mode === 'video');
  const derivedKeys = DERIVED_METRICS.map(([k]) => k);
  const out = [];
  for (const c of rows) {
    for (const f of c.thermal_frames || []) {
      out.push([c.capture_id, c.subject_id, c.name, f.t, f.t_sync, f.occluded_count, (f.frame_temp_c || {}).min, (f.frame_temp_c || {}).max,
        ...derivedKeys.map((k) => (f.derived || {})[k]), ...REGION_KEYS.map((k) => ((f.regions || {})[k] || {}).mean_c)]);
    }
  }
  downloadCsv('thermal_video_frames',
    ['capture_id', 'subject_id', 'name', 't_thermal_s', 't_rgb_s', 'occluded_count', 'frame_min_c', 'frame_max_c', ...derivedKeys,
      ...REGION_KEYS.map((k) => `${k}_mean_c`)], out);
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
  renderKpis(rows);
  const empty = rows.length === 0;
  $('emptyState').hidden = !empty;
  $('emptyTitle').textContent = state.captures.length ? 'No thermal readings match these filters.' : 'No thermal readings yet.';
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = empty || p.dataset.panel !== state.tab; });
  if (empty) return;
  if (state.tab === 'overview') renderOverview(rows);
  if (state.tab === 'emotion') renderEmotion(rows);
  if (state.tab === 'groups') renderGroups(rows);
  if (state.tab === 'videos') renderVideos(rows);
  if (state.tab === 'readings') renderReadings(rows);
  if (state.tab === 'participants') renderParticipants(rows);
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.range)));
for (const id of ['fFromDate', 'fToDate', 'fMode', 'fPage', 'fSource', 'fDiet', 'fGender', 'fEmotion', 'fQuality', 'eMetric', 'gGroup', 'gMetric', 'vMetric', 'vMode']) {
  $(id).addEventListener('change', render);
}
let inputTimer;
$('fSearch').addEventListener('input', () => {
  clearTimeout(inputTimer);
  inputTimer = setTimeout(render, 200);
});
$('resetBtn').addEventListener('click', () => {
  for (const id of ['fFromDate', 'fToDate', 'fMode', 'fPage', 'fSource', 'fDiet', 'fGender', 'fEmotion', 'fSearch']) $(id).value = '';
  $('fQuality').value = '';
  document.querySelectorAll('.preset').forEach((b) => b.classList.remove('is-active'));
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
    if (state.detail && state.detail.capture_mode === 'video') detailTimeline(state.detail);
  }, 150);
});

load();
