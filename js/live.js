// Live strips for the record page: the last seconds of each stream, redrawn every animation frame. Samples arrive from
// .NET (Services/LiveSession.cs) in batches, about 10 a second, as memory views on each lane's own device clock.

const LANES = [
  { label: 'ECG', unit: 'mV', color: '#111111' },
  { label: 'Movesense |a|', unit: 'G', color: '#4b5563' },
  { label: 'Polar PPG ch0 (raw)', unit: '', color: '#1d4ed8' },
  { label: 'Polar |a|', unit: 'G', color: '#d97706' },
];
const CAPACITY = 16384;      // samples kept per lane (≥ 60 s at 208 Hz)
const STALE_S = 3;           // a lane with nothing newer than this (host time) is shown as "no data"
const LABEL_W = 150, GAP = 6, FONT = '"Segoe UI", system-ui, sans-serif';

let canvas = null, ctx = null, windowS = 8, running = false;
const lanes = LANES.map(l => ({ ...l, t: new Float64Array(CAPACITY), y: new Float64Array(CAPACITY), start: 0, count: 0, rx: 0 }));

export function init(canvasId) {
  canvas = document.getElementById(canvasId);
  ctx = canvas?.getContext('2d') ?? null;
  if (!running) { running = true; requestAnimationFrame(frame); }
}

export function setWindow(seconds) { windowS = seconds; }

export function clear(lane) {
  const l = lanes[lane];
  l.start = 0; l.count = 0; l.rx = 0;
}

/** Appends samples (t in s on the stream's own clock, ascending). */
export function push(lane, t, y) {
  const l = lanes[lane];
  const tt = t.slice(), yy = y.slice();
  for (let i = 0; i < tt.length; i++) {
    // A clock that goes back (sensor restart, reconnect to a rebooted band) starts the lane afresh.
    if (l.count > 0 && tt[i] < l.t[(l.start + l.count - 1) % CAPACITY] - 1) { l.start = 0; l.count = 0; }
    const at = (l.start + l.count) % CAPACITY;
    l.t[at] = tt[i]; l.y[at] = yy[i];
    if (l.count < CAPACITY) l.count++; else l.start = (l.start + 1) % CAPACITY;
  }
  l.rx = performance.now() / 1000;
}

function frame() {
  if (canvas && canvas.isConnected && document.visibilityState === 'visible') draw();
  else if (canvas && !canvas.isConnected) { canvas = null; ctx = null; }
  requestAnimationFrame(frame);
}

function text(s, x, y, size, color, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.fillText(s, x, y);
}

function num(x, range) {
  const d = range > 0 ? Math.min(4, Math.max(0, 2 - Math.floor(Math.log10(range)))) : 2;
  return x.toFixed(d);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const laneH = (h - GAP * (lanes.length - 1)) / lanes.length;
  const plotW = Math.max(10, w - LABEL_W - 8);
  const nowRx = performance.now() / 1000;
  lanes.forEach((l, i) => {
    const top = i * (laneH + GAP);
    ctx.strokeStyle = '#d1d5db';
    ctx.strokeRect(LABEL_W + 0.5, top + 0.5, plotW - 1, laneH - 1);
    text(l.label, 4, top + 2, 12, '#1f2937', 600);
    const fresh = l.count > 1 && nowRx - l.rx < STALE_S;
    if (!fresh) { text(l.count > 1 ? 'no new data' : 'no data', 4, top + 18, 11, '#6b7280'); return; }
    const last = l.t[(l.start + l.count - 1) % CAPACITY], from = last - windowS;
    // Visible samples: walk back from the newest.
    let n = 0, lo = Infinity, hi = -Infinity;
    for (let k = l.count - 1; k >= 0; k--) {
      const j = (l.start + k) % CAPACITY;
      if (l.t[j] < from) break;
      const v = l.y[j];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      n++;
    }
    if (!(hi >= lo)) { text('no data', 4, top + 18, 11, '#6b7280'); return; }
    if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) { lo -= 0.5; hi += 0.5; }
    const pad = 0.08 * (hi - lo), ylo = lo - pad, yhi = hi + pad;
    text(`${num(lo, hi - lo)} … ${num(hi, hi - lo)} ${l.unit}`, 4, top + 18, 11, '#6b7280');
    const X = t => LABEL_W + (t - from) / windowS * plotW;
    const Y = v => top + laneH - (v - ylo) / (yhi - ylo) * laneH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, top, plotW, laneH);
    ctx.clip();
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let prevT = null;
    for (let k = l.count - n; k < l.count; k++) {
      const j = (l.start + k) % CAPACITY;
      const t = l.t[j], v = l.y[j];
      if (!Number.isFinite(v)) { prevT = null; continue; }
      // Never join across a hole of more than 0.25 s (lost packets show as breaks).
      if (prevT === null || t - prevT > 0.25) ctx.moveTo(X(t), Y(v)); else ctx.lineTo(X(t), Y(v));
      prevT = t;
    }
    ctx.stroke();
    ctx.restore();
  });
}
