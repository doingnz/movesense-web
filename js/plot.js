// Recording plot on a canvas: a port of the desktop RecordingPlot (src/MovesenseGsp.App/Controls/RecordingPlot.cs) and
// of RecordingPlotWindow's status line. The data comes from .NET (RecordingPlotData) through [JSImport] calls
// (Interop/PlotInterop.cs).
//
// A coverage bar per stream (grey = data, red = gap) above the signal lanes, gaps shaded. Traces are drawn per pixel
// column (min/max) when zoomed out, sample by sample when zoomed in, and never joined across a gap. Wheel zooms around
// the pointer, dragging pans, double-click shows everything, arrow keys move.

const LABEL_W = 170, RIGHT_PAD = 12, AXIS_H = 24, COV_ROW = 16, LANE_GAP = 6, MIN_SPAN = 0.05, GAP_FACTOR = 1.5;
const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const COLOR = {
  paper: '#ffffff', dataBar: '#c7cdd6', gapBar: '#dc2626', gapShade: 'rgba(220, 38, 38, 0.22)',
  ink: '#1f2937', muted: '#6b7280', frame: '#d1d5db', grid: '#eef0f3',
};
const FONT = '"Segoe UI", system-ui, sans-serif';
const HINT = 'Mouse wheel: zoom · drag: pan · ← →: move · double-click: whole recording';

let canvas = null, ctx = null, statusEl = null;
let lanes = [], coverage = [], origin = 0;
let t0 = 0, t1 = 1, v0 = 0, v1 = 1;
let drag = null, cursorT = null, frameRequested = false;

// ---------------- API (PlotInterop) ----------------

export function init(canvasId, statusId) {
  const c = document.getElementById(canvasId);
  statusEl = document.getElementById(statusId);
  if (c === canvas) return;
  canvas = c;
  ctx = canvas.getContext('2d');
  new ResizeObserver(requestDraw).observe(canvas);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { cursorT = null; updateStatus(); });
  canvas.addEventListener('dblclick', () => showAll());
  canvas.addEventListener('keydown', onKeyDown);
}

export function clear(originUnixSeconds) {
  lanes = [];
  coverage = [];
  origin = originUnixSeconds;
  cursorT = null;
}

export function addCoverage(name, start, end, period, gapStarts, gapEnds) {
  // Memory views are only valid during the call: copy them.
  coverage.push({ name, start, end, period, gs: gapStarts.slice(), ge: gapEnds.slice() });
}

export function addLane(label, unit, color, dots, cov, t, y) {
  lanes.push({ label, unit, color, dots, cov: cov >= 0 ? coverage[cov] : null, t: t.slice(), y: y.slice() });
}

export function showAll() {
  const live = lanes.filter(l => l.t.length > 0);
  t0 = live.length ? Math.min(...live.map(l => l.t[0])) : 0;
  t1 = live.length ? Math.max(Math.max(...live.map(l => l.t[l.t.length - 1])), t0 + 1) : 1;
  setView(t0, t1);
}

export function setView(a, b) {
  const span = clamp(b - a, MIN_SPAN, Math.max(MIN_SPAN, t1 - t0));
  a = clamp(a, t0, Math.max(t0, t1 - span));
  v0 = a;
  v1 = a + span;
  requestDraw();
  updateStatus();
}

export function zoom(factor, centre) {
  const c = centre ?? (v0 + v1) / 2;
  setView(c - (c - v0) * factor, c + (v1 - c) * factor);
}

export function saveImage(fileName, title) {
  // The plot under a title line, at the screen's resolution.
  const dpr = window.devicePixelRatio || 1, head = 34 * dpr;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height + head;
  const o = out.getContext('2d');
  o.fillStyle = COLOR.paper;
  o.fillRect(0, 0, out.width, out.height);
  o.fillStyle = COLOR.ink;
  o.font = `600 ${15 * dpr}px ${FONT}`;
  o.textBaseline = 'middle';
  o.fillText(title, 8 * dpr, head / 2);
  o.drawImage(canvas, 0, head);
  out.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, 'image/png');
}

export function folderName(inputId) {
  const f = document.getElementById(inputId)?.files?.[0];
  return f?.webkitRelativePath ? f.webkitRelativePath.split('/')[0] : '';
}

// ---------------- geometry ----------------

const cssWidth = () => canvas.clientWidth;
const plotWidth = () => Math.max(1, cssWidth() - LABEL_W - RIGHT_PAD);
const X = t => LABEL_W + (t - v0) / (v1 - v0) * plotWidth();
const timeAt = x => v0 + (x - LABEL_W) / plotWidth() * (v1 - v0);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

function lowerBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Indexes of the gaps overlapping the view (gaps ascending by start). */
function* visibleGaps(c) {
  let lo = 0, hi = c.gs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (c.ge[mid] < v0) lo = mid + 1; else hi = mid;
  }
  for (let i = lo; i < c.gs.length && c.gs[i] <= v1; i++) yield i;
}

// ---------------- input ----------------

function onWheel(e) {
  e.preventDefault();
  const x = e.offsetX;
  zoom(e.deltaY < 0 ? 1 / 1.4 : 1.4, x >= LABEL_W ? timeAt(x) : undefined);
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  canvas.focus();
  drag = { x: e.offsetX, v0 };
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  const x = e.offsetX;
  if (drag) {
    const span = v1 - v0;
    const a = drag.v0 - (x - drag.x) / plotWidth() * span;
    setView(a, a + span);
  }
  cursorT = x >= LABEL_W && x <= LABEL_W + plotWidth() ? timeAt(x) : null;
  updateStatus();
}

function onPointerUp(e) {
  drag = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
}

function onKeyDown(e) {
  const span = v1 - v0;
  switch (e.key) {
    case 'ArrowLeft': setView(v0 - span / 4, v1 - span / 4); break;
    case 'ArrowRight': setView(v0 + span / 4, v1 + span / 4); break;
    case '+': case '=': zoom(1 / 1.4); break;
    case '-': case '_': zoom(1.4); break;
    case 'Home': showAll(); break;
    default: return;
  }
  e.preventDefault();
}

// ---------------- status line ----------------

/** Seconds from the origin as m:ss or h:mm:ss, with decimals when the step needs them (RecordingPlot.FormatTime). */
export function formatTime(seconds, step = 1) {
  const sign = seconds < 0 ? '−' : '';
  seconds = Math.abs(seconds);
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const rounded = +seconds.toFixed(decimals);
  const h = Math.floor(rounded / 3600), m = Math.floor((rounded % 3600) / 60), s = rounded % 60;
  const sec = s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${sec}` : `${sign}${m}:${sec}`;
}

const utc = t => new Date(Math.round((origin + t) * 1000)).toISOString().slice(11, 21);
const gapText = g => g < 1 ? `${(g * 1000).toFixed(0)} ms` : `${g.toFixed(1)} s`;

function updateStatus() {
  if (!statusEl) return;
  const view = `showing ${formatTime(v0)}–${formatTime(v1)} (${formatTime(v1 - v0, 0.1)})`;
  if (cursorT === null) {
    statusEl.textContent = `${view} · ${HINT}`;
    return;
  }
  const inGaps = [];
  for (const c of coverage) {
    const i = lowerBound(c.ge, cursorT);
    if (i < c.gs.length && c.gs[i] <= cursorT) inGaps.push(`${c.name} gap of ${gapText(c.ge[i] - c.gs[i])}`);
  }
  statusEl.textContent = `${formatTime(cursorT, 0.01)} = ${utc(cursorT)} UTC (as in the log file)` +
    (inGaps.length ? ` · in: ${inGaps.join(', ')}` : '') + ` · ${view}`;
}

// ---------------- drawing ----------------

function requestDraw() {
  if (frameRequested || !canvas) return;
  frameRequested = true;
  requestAnimationFrame(() => { frameRequested = false; draw(); });
}

function text(s, x, y, size, color, maxWidth, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  if (ctx.measureText(s).width > maxWidth) {
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    s += '…';
  }
  ctx.fillText(s, x, y);
}

function ticks(width) {
  const span = v1 - v0;
  const target = span / Math.max(2, width / 110);
  const step = TICK_STEPS.find(s => s >= target) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const list = [];
  for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) list.push(t);
  return { step, list };
}

/** A scale label with 2–3 significant digits of the visible range (RecordingPlot.Num). */
function num(x, range) {
  const decimals = range > 0 ? clamp(2 - Math.floor(Math.log10(range)), 0, 4) : 2;
  return Math.abs(x) >= 10000 && decimals === 0 ? Math.round(x).toLocaleString('en-US') : x.toFixed(decimals);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLOR.paper;
  ctx.fillRect(0, 0, w, h);
  if (lanes.length === 0 || w < LABEL_W + 40 || h < 80) return;
  const left = LABEL_W, width = plotWidth();

  // Coverage bars: grey where the stream has data, red where it has a gap (at least 1 px wide).
  let y = 4;
  for (const c of coverage) {
    text(c.name, 4, y + 1, 11, COLOR.muted, LABEL_W - 8);
    const a = Math.max(left, X(c.start)), b = Math.min(left + width, X(c.end));
    if (b > a) { ctx.fillStyle = COLOR.dataBar; ctx.fillRect(a, y + 3, b - a, 10); }
    ctx.fillStyle = COLOR.gapBar;
    for (const i of visibleGaps(c)) {
      const ga = Math.max(left, X(c.gs[i])), gb = Math.min(left + width, X(c.ge[i]));
      ctx.fillRect(ga, y + 3, Math.max(1, gb - ga), 10);
    }
    y += COV_ROW;
  }
  y += 6;

  const top = y, bottom = h - AXIS_H, n = lanes.length;
  const laneH = (bottom - top - LANE_GAP * (n - 1)) / n;
  if (laneH < 12) return;
  const { step, list } = ticks(width);

  for (let i = 0; i < n; i++) {
    const lane = lanes[i];
    const r = { left, top: top + i * (laneH + LANE_GAP), width, height: laneH };
    r.bottom = r.top + r.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, r.width, r.height);
    ctx.clip();
    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of list) { const x = Math.round(X(t)) + 0.5; ctx.moveTo(x, r.top); ctx.lineTo(x, r.bottom); }
    ctx.stroke();
    if (lane.cov) {
      ctx.fillStyle = COLOR.gapShade;
      for (const g of visibleGaps(lane.cov)) {
        const ga = X(lane.cov.gs[g]), gb = X(lane.cov.ge[g]);
        ctx.fillRect(ga, r.top, Math.max(1, gb - ga), r.height);
      }
    }
    const range = drawTrace(lane, r);
    ctx.restore();
    ctx.strokeStyle = COLOR.frame;
    ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);

    text(lane.label, 4, r.top + 2, 12, COLOR.ink, LABEL_W - 8, 600);
    text(range ? `${num(range.lo, range.hi - range.lo)} … ${num(range.hi, range.hi - range.lo)} ${lane.unit}` : 'no data here',
      4, r.top + 18, 11, COLOR.muted, LABEL_W - 8);
  }

  // Time axis: time from the start of the recording.
  ctx.strokeStyle = COLOR.frame;
  ctx.beginPath();
  for (const t of list) { const x = Math.round(X(t)) + 0.5; ctx.moveTo(x, bottom); ctx.lineTo(x, bottom + 4); }
  ctx.stroke();
  ctx.font = `400 11px ${FONT}`;
  ctx.fillStyle = COLOR.muted;
  ctx.textBaseline = 'top';
  for (const t of list) {
    const s = formatTime(t, step), tw = ctx.measureText(s).width;
    ctx.fillText(s, clamp(X(t) - tw / 2, left, left + width - tw), bottom + 6);
  }
}

/** Draws the visible part of a lane scaled to its visible values; returns that value range. */
function drawTrace(lane, r) {
  const t = lane.t, v = lane.y;
  const i0 = Math.max(0, lowerBound(t, v0) - 1), i1 = Math.min(t.length, lowerBound(t, v1) + 1);
  if (i1 - i0 < 1) return null;
  const limit = lane.cov && lane.cov.period > 0 ? lane.cov.period * GAP_FACTOR : Infinity;
  const columns = Math.max(1, Math.floor(r.width));
  const perSample = i1 - i0 <= 2 * columns;

  // Per pixel column: min, max, first, last, and the first/last sample index for the gap test.
  let colMin, colMax, colFirst, colLast, colI0, colI1;
  let values;
  if (!perSample) {
    colMin = new Float64Array(columns); colMax = new Float64Array(columns);
    colFirst = new Float64Array(columns); colLast = new Float64Array(columns);
    colI0 = new Int32Array(columns).fill(-1); colI1 = new Int32Array(columns);
    const scale = columns / (v1 - v0);
    for (let i = i0; i < i1; i++) {
      const yv = v[i];
      if (Number.isNaN(yv)) continue;
      const col = Math.floor((t[i] - v0) * scale);
      if (col < 0 || col >= columns) continue;
      if (colI0[col] < 0) { colI0[col] = i; colMin[col] = colMax[col] = colFirst[col] = yv; }
      else { if (yv < colMin[col]) colMin[col] = yv; if (yv > colMax[col]) colMax[col] = yv; }
      colLast[col] = yv;
      colI1[col] = i;
    }
    values = [];
    for (let col = 0; col < columns; col++) if (colI0[col] >= 0) values.push(colMin[col], colMax[col]);
  } else {
    values = [];
    for (let i = i0; i < i1; i++) if (!Number.isNaN(v[i]) && t[i] >= v0 && t[i] <= v1) values.push(v[i]);
  }
  if (values.length === 0) return null;

  // Scale: the visible values without the most extreme ones, with a margin. Zoomed out, the values are the columns'
  // extremes, and a few columns of taps or movement must not flatten the rest: 1 % each side. Zoomed in they are the
  // samples themselves: 0.1 % (an ECG's R-peaks are ~2 % of its samples).
  values.sort((a, b) => a - b);
  const q = perSample ? 0.001 : 0.01;
  let lo = values[Math.floor(q * (values.length - 1))], hi = values[Math.ceil((1 - q) * (values.length - 1))];
  if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) { lo -= 0.5; hi += 0.5; }
  const pad = 0.08 * (hi - lo), ylo = lo - pad, yhi = hi + pad;
  const Y = val => r.bottom - (val - ylo) / (yhi - ylo) * r.height;

  if (lane.dots) {
    ctx.fillStyle = lane.color;
    for (let i = i0; i < i1; i++) if (!Number.isNaN(v[i])) ctx.fillRect(X(t[i]) - 1.5, Y(v[i]) - 1.5, 3, 3);
    return { lo, hi };
  }

  ctx.strokeStyle = lane.color;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (perSample) {
    let prev = -1;
    for (let i = i0; i < i1; i++) {
      if (Number.isNaN(v[i])) { prev = -1; continue; }
      const x = X(t[i]), yy = Y(v[i]);
      if (prev < 0 || t[i] - t[prev] > limit) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      prev = i;
    }
  } else {
    let prevCol = -2;
    for (let col = 0; col < columns; col++) {
      if (colI0[col] < 0) continue;
      const x = r.left + col + 0.5;
      const joined = prevCol === col - 1 && t[colI0[col]] - t[colI1[prevCol]] <= limit;
      if (joined) ctx.lineTo(x, Y(colFirst[col])); else ctx.moveTo(x, Y(colFirst[col]));
      ctx.lineTo(x, Y(colMax[col]));
      ctx.lineTo(x, Y(colMin[col]));
      ctx.lineTo(x, Y(colLast[col]));
      prevCol = col;
    }
  }
  ctx.stroke();
  return { lo, hi };
}
