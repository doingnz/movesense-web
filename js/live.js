// Live strips for the record page: the last seconds of each stream, redrawn every animation frame. Samples arrive from
// .NET (Services/LiveSession.cs) in batches, about 10 a second, as memory views on each lane's own device clock.
// Beat markers (PPG beats, ECG R-peaks) come once a second on the same clocks; the tachogram and the tap-sync beeps
// are here too.

const LANES = [
  { label: 'ECG', unit: 'mV', color: '#111111' },
  { label: 'Movesense |a|', unit: 'G', color: '#4b5563' },
  { label: 'Polar PPG ch0', sub: '0.5–8 Hz, inverted', unit: '', color: '#1d4ed8' },
  { label: 'Polar |a|', unit: 'G', color: '#d97706' },
];
const CAPACITY = 16384;      // samples kept per lane (≥ 60 s at 208 Hz)
const STALE_S = 3;           // a lane with nothing newer than this (host time) is shown as "no data"
const LABEL_W = 150, GAP = 6, FONT = '"Segoe UI", system-ui, sans-serif';

let canvas = null, ctx = null, windowS = 8, running = false;
const lanes = LANES.map(l => ({ ...l, t: new Float64Array(CAPACITY), y: new Float64Array(CAPACITY), start: 0, count: 0, rx: 0, marks: [] }));

export function init(canvasId) {
  canvas = document.getElementById(canvasId);
  ctx = canvas?.getContext('2d') ?? null;
  if (!running) { running = true; requestAnimationFrame(frame); }
}

export function setWindow(seconds) { windowS = seconds; }

export function clear(lane) {
  const l = lanes[lane];
  l.start = 0; l.count = 0; l.rx = 0; l.marks = [];
}

/** Appends samples (t in s on the stream's own clock, ascending). */
export function push(lane, t, y) {
  const l = lanes[lane];
  const tt = t.slice(), yy = y.slice();
  for (let i = 0; i < tt.length; i++) {
    // A clock that goes back (sensor restart, reconnect to a rebooted band) starts the lane afresh.
    if (l.count > 0 && tt[i] < l.t[(l.start + l.count - 1) % CAPACITY] - 1) { l.start = 0; l.count = 0; l.marks = []; }
    const at = (l.start + l.count) % CAPACITY;
    l.t[at] = tt[i]; l.y[at] = yy[i];
    if (l.count < CAPACITY) l.count++; else l.start = (l.start + 1) % CAPACITY;
  }
  l.rx = performance.now() / 1000;
}

/** Replaces a lane's markers: times on the lane's clock, and 1 (good, filled) or 0 (rejected, hollow). */
export function markers(lane, t, good) {
  const tt = t.slice(), gg = good.slice();
  lanes[lane].marks = Array.from(tt, (x, i) => ({ t: x, good: gg[i] > 0 }));
}

function frame() {
  if (canvas && canvas.isConnected && document.visibilityState === 'visible') draw();
  else if (canvas && !canvas.isConnected) { canvas = null; ctx = null; }
  requestAnimationFrame(frame);
}

function text(c, s, x, y, size, color, weight = 400) {
  c.font = `${weight} ${size}px ${FONT}`;
  c.fillStyle = color;
  c.textBaseline = 'top';
  c.fillText(s, x, y);
}

function num(x, range) {
  const d = range > 0 ? Math.min(4, Math.max(0, 2 - Math.floor(Math.log10(range)))) : 2;
  return x.toFixed(d);
}

function fit(c, el) {
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth, h = el.clientHeight;
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
  }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [w, h];
}

function draw() {
  const [w, h] = fit(ctx, canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const laneH = (h - GAP * (lanes.length - 1)) / lanes.length;
  const plotW = Math.max(10, w - LABEL_W - 8);
  const nowRx = performance.now() / 1000;
  lanes.forEach((l, i) => {
    const top = i * (laneH + GAP);
    ctx.strokeStyle = '#d1d5db';
    ctx.strokeRect(LABEL_W + 0.5, top + 0.5, plotW - 1, laneH - 1);
    text(ctx, l.label, 4, top + 2, 12, '#1f2937', 600);
    let line = 18;
    if (l.sub) { text(ctx, l.sub, 4, top + line, 11, '#6b7280'); line += 15; }
    const fresh = l.count > 1 && nowRx - l.rx < STALE_S;
    if (!fresh) { text(ctx, l.count > 1 ? 'no new data' : 'no data', 4, top + line, 11, '#6b7280'); return; }
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
    if (!(hi >= lo)) { text(ctx, 'no data', 4, top + line, 11, '#6b7280'); return; }
    if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) { lo -= 0.5; hi += 0.5; }
    const pad = 0.08 * (hi - lo), ylo = lo - pad, yhi = hi + pad;
    text(ctx, `${num(lo, hi - lo)} … ${num(hi, hi - lo)} ${l.unit}`, 4, top + line, 11, '#6b7280');
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
    // Markers: small triangles along the lane's top edge, green when the beat passed the quality gates.
    for (const m of l.marks) {
      if (m.t < from || m.t > last) continue;
      const x = X(m.t);
      ctx.beginPath();
      ctx.moveTo(x - 4, top + 2); ctx.lineTo(x + 4, top + 2); ctx.lineTo(x, top + 9); ctx.closePath();
      if (m.good) { ctx.fillStyle = '#16a34a'; ctx.fill(); } else { ctx.strokeStyle = '#9ca3af'; ctx.stroke(); }
    }
    ctx.restore();
  });
}

/**
 * The tachogram: intervals in ms, oldest first, on a common auto-range (at least 200 ms span, as on the desktop).
 * rr: the Movesense's own RR (green); ppi: PPG pulse-to-pulse intervals (blue).
 */
export function tacho(canvasId, rr, ppi) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  const c = el.getContext('2d');
  const [w, h] = fit(c, el);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w, h);
  const a = rr.slice(), b = ppi.slice();
  const all = [...a, ...b];
  if (all.length < 2) { text(c, 'Intervals appear after a few beats', 6, h / 2 - 7, 12, '#6b7280'); return; }
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 200) { const mid = (lo + hi) / 2; lo = mid - 100; hi = mid + 100; }
  const N = 120, top = 4, bottom = h - 16;
  const Y = v => bottom - (v - lo) / (hi - lo) * (bottom - top);
  const series = (v, color) => {
    if (v.length < 2) return;
    c.strokeStyle = color; c.lineWidth = 1.5; c.beginPath();
    const off = N - v.length;
    v.forEach((x, i) => { const px = (off + i) / (N - 1) * (w - 4) + 2; if (i) c.lineTo(px, Y(x)); else c.moveTo(px, Y(x)); });
    c.stroke();
  };
  series(a, '#16a34a');
  series(b, '#1d4ed8');
  text(c, `${Math.round(lo)}–${Math.round(hi)} ms`, 4, h - 14, 11, '#6b7280');
}

// ---------------- tap-sync beeps (Web Audio) ----------------

let audio = null;

/** Creates or resumes the audio context; call it in a click handler so the browser allows sound later. */
export function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch (err) { console.warn('audio', err); }
}

/** count beeps of 200 ms at frequency Hz, 100 ms apart (the desktop's Console.Beep pattern). */
export function beep(frequency, count) {
  try {
    unlockAudio();
    if (!audio) return;
    const t0 = audio.currentTime + 0.02;
    for (let i = 0; i < count; i++) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = frequency;
      o.type = 'square';
      const s = t0 + i * 0.3;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.15, s + 0.01);
      g.gain.setValueAtTime(0.15, s + 0.19);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.2);
      o.connect(g).connect(audio.destination);
      o.start(s);
      o.stop(s + 0.21);
    }
  } catch (err) { console.warn('beep', err); }
}
