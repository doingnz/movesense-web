// Simulated sensors for the web app (no hardware, and for automated tests): a Movesense speaking GSP and a Polar band
// speaking PMD, behind the same calls as real Web Bluetooth devices (ble.js routes "sim-" ids here). The bytes follow
// PROTOCOL.md §2–3 (GSP: HELLO, SUBSCRIBE, DATA + DATA_PART2 for IMU6) and PmdFrameDecoder (PPG frame type 0: 4 × 24-bit,
// ACC frame type 1: 3 × 16-bit). Signals: a synthetic ECG at ~66 bpm, a wrist pulse ~180 ms after each R wave, and both
// sensors tapped together 6 times every 25 s, so the viewer's offline tap-sync has something to find.

const ECG_LSB_MV = 0.38147e-3;
const POLAR_EPOCH_MS = Date.UTC(2000, 0, 1);
const t0 = performance.now();                   // simulation clock origin, ms
const bootMs = 123456;                          // the simulated Movesense "uptime" at t0
const polarNs0 = BigInt(Date.now() - POLAR_EPOCH_MS) * 1000000n;

const sleepRand = () => (Math.random() - 0.5);
const nowS = () => (performance.now() - t0) / 1000;

// ---- shared physiology: beat times, taps ----
const beats = [0.4];
function beatsAround(t) {
  while (beats[beats.length - 1] < t + 2) beats.push(beats[beats.length - 1] + 0.9 + 0.06 * sleepRand());
  return beats.filter(b => b > t - 1.5 && b < t + 1.5);
}
function tapAccel(t) {
  // 6 taps, 0.8 s apart, starting 10 s in and every 25 s after that.
  const k = (t - 10) % 25;
  if (t < 10 || k < 0 || k > 5) return 0;
  const phase = k % 0.8;
  return phase < 0.03 ? 2.5 * Math.exp(-phase / 0.01) : 0;
}
const gauss = (x, mu, s) => Math.exp(-0.5 * ((x - mu) / s) ** 2);
function ecgMv(t) {
  let v = 0.04 * Math.sin(2 * Math.PI * 0.25 * t);
  for (const b of beatsAround(t)) {
    const x = t - b;
    v += 0.15 * gauss(x, -0.16, 0.025) - 0.1 * gauss(x, -0.03, 0.008) + 1.2 * gauss(x, 0, 0.01)
       - 0.3 * gauss(x, 0.025, 0.01) + 0.3 * gauss(x, 0.25, 0.05);
  }
  return v + 0.01 * sleepRand();
}
function pulse(t) {
  let v = 0;
  for (const b of beatsAround(t)) {
    const x = t - b - 0.18;
    if (x > 0 && x < 0.8) v += (x < 0.12 ? x / 0.12 : Math.exp(-(x - 0.12) / 0.25));
  }
  return v;
}

// ---- device registry ----
const sims = new Map(); // id -> { kind, connected, timers, handlers }
let dotnet = null;
export function bind(d) { dotnet = d; }

export function pick(kind) {
  const id = kind === 'movesense' ? 'sim-movesense' : 'sim-polar';
  if (!sims.has(id)) sims.set(id, { kind, connected: false, timers: new Map() });
  return `${id}\n${kind === 'movesense' ? 'Movesense 000000000000 (simulated)' : 'Polar Sense SIMULATED'}`;
}

export function connect(id) {
  const s = sims.get(id);
  s.connected = true;
  return new Promise(r => setTimeout(r, 150));
}

export function isConnected(id) { return !!sims.get(id)?.connected; }

function stopAll(s) { for (const t of s.timers.values()) clearInterval(t); s.timers.clear(); }

export function disconnect(id) {
  const s = sims.get(id);
  if (!s) return;
  stopAll(s);
  s.connected = false;
}

/** For tests: the link drops (as a sensor going out of range would). */
export function drop(id) {
  const s = sims.get(id);
  if (!s?.connected) return;
  stopAll(s);
  s.connected = false;
  setTimeout(() => dotnet.OnDisconnected(id), 0);
}

const notify = (id, kind, bytes) => setTimeout(() => {
  const s = sims.get(id);
  if (!s?.connected) return;
  if (kind === 'gsp') dotnet.OnGspNotification(id, bytes);
  else if (kind === 'cp') dotnet.OnPmdControl(id, bytes);
  else dotnet.OnPmdData(id, bytes);
}, 5);

// ---- Movesense (GSP) ----
function gspCommand(id, data) {
  const s = sims.get(id);
  const [cmd, ref] = data;
  const path = new TextDecoder().decode(data.slice(2));
  if (cmd === 0) {         // HELLO: status 200, version, serial, product, DFU MAC, app name, app version
    const strings = ['000000000000', 'Movesense MD (simulated)', '00:00:00:00:00:00', 'Default Firmware', '1.0.1'];
    const body = strings.flatMap(x => [...new TextEncoder().encode(x), 0]);
    notify(id, 'gsp', new Uint8Array([1, ref, 0xc8, 0x00, 1, ...body]));
  } else if (cmd === 1) {  // SUBSCRIBE
    notify(id, 'gsp', new Uint8Array([1, ref, 0xc8, 0x00]));
    startGsp(id, s, ref, path);
  } else if (cmd === 2) {  // UNSUBSCRIBE: MD firmware sends no response
    const t = s.timers.get(ref);
    if (t) { clearInterval(t); s.timers.delete(ref); }
  }
}

function startGsp(id, s, ref, path) {
  if (s.timers.has(ref)) clearInterval(s.timers.get(ref));
  const startS = nowS();
  let sent = 0;
  if (path.startsWith('/Meas/ECG/')) {
    const rate = Number(path.split('/')[3]), n = 16;
    s.timers.set(ref, setInterval(() => {
      while ((sent + n) / rate <= nowS() - startS) {
        const first = startS + sent / rate;
        const p = new DataView(new ArrayBuffer(2 + 4 + 4 * n));
        p.setUint8(0, 2); p.setUint8(1, ref);
        p.setUint32(2, Math.round(bootMs + first * 1000) >>> 0, true);
        for (let i = 0; i < n; i++) p.setInt32(6 + 4 * i, Math.round(ecgMv(first + i / rate) / ECG_LSB_MV), true);
        notify(id, 'gsp', new Uint8Array(p.buffer));
        sent += n;
      }
    }, 40));
  } else if (path.startsWith('/Meas/IMU6/')) {
    const rate = Number(path.split('/')[3]), n = 8;
    s.timers.set(ref, setInterval(() => {
      while ((sent + n) / rate <= nowS() - startS) {
        const first = startS + sent / rate;
        const payload = new DataView(new ArrayBuffer(4 + 24 * n));
        payload.setUint32(0, Math.round(bootMs + first * 1000) >>> 0, true);
        for (let i = 0; i < n; i++) {
          const t = first + i / rate, tap = tapAccel(t) * 9.80665;
          const acc = [0.3 + 0.05 * sleepRand(), -9.7 + 0.05 * sleepRand() - tap, 1.4 + 0.05 * sleepRand()];
          acc.forEach((v, k) => payload.setFloat32(4 + 12 * i + 4 * k, v, true));
          [1.4, -3.9, 0].forEach((v, k) => payload.setFloat32(4 + 12 * n + 12 * i + 4 * k, v + 0.2 * sleepRand(), true));
        }
        const bytes = new Uint8Array(payload.buffer);
        // The sensor sends the first 150 bytes as DATA and the rest as DATA_PART2 (PROTOCOL.md §2.6).
        notify(id, 'gsp', new Uint8Array([2, ref, ...bytes.slice(0, 150)]));
        notify(id, 'gsp', new Uint8Array([3, ref, ...bytes.slice(150)]));
        sent += n;
      }
    }, 20));
  } else if (path === '/Meas/HR') {
    let lastBeat = 0;
    s.timers.set(ref, setInterval(() => {
      const t = nowS(), recent = beats.filter(b => b > lastBeat && b <= t);
      if (recent.length === 0) return;
      const rr = recent.map(b => { const i = beats.indexOf(b); return i > 0 ? Math.round((b - beats[i - 1]) * 1000) : 900; });
      lastBeat = recent[recent.length - 1];
      const p = new DataView(new ArrayBuffer(2 + 4 + 2 * rr.length));
      p.setUint8(0, 2); p.setUint8(1, ref);
      p.setFloat32(2, 60000 / (rr.reduce((a, b) => a + b, 0) / rr.length), true);
      rr.forEach((v, i) => p.setUint16(6 + 2 * i, v, true));
      notify(id, 'gsp', new Uint8Array(p.buffer));
    }, 1000));
  }
}

// ---- Polar (PMD) ----
const PMD_SETTINGS = {
  1: [0, 5, 28, 0, 44, 0, 55, 0, 135, 0, 176, 0, 1, 1, 22, 0, 4, 1, 4],                       // PPG: rates, 22 bit, 4 channels
  2: [0, 5, 26, 0, 52, 0, 104, 0, 208, 0, 160, 1, 1, 1, 16, 0, 2, 4, 2, 0, 4, 0, 8, 0, 16, 0, 4, 1, 3], // ACC
};
let sdkMode = false;

function pmdCommand(id, data) {
  const s = sims.get(id);
  const [op, m] = data;
  const reply = (status, params = []) => notify(id, 'cp', new Uint8Array([0xf0, op, m, status, 0, ...params]));
  if (op === 4 || op === 1) { reply(PMD_SETTINGS[m] ? 0 : 3, PMD_SETTINGS[m] ?? []); return; }
  if (op === 2) {
    if (m === 9) { reply(sdkMode ? 6 : 0); sdkMode = true; return; }
    if (!PMD_SETTINGS[m]) { reply(3); return; }
    const rate = data[2] === 0 ? data[4] | (data[5] << 8) : (m === 1 ? 176 : 208);
    reply(s.timers.has(m) ? 6 : 0);
    startPmd(id, s, m, rate);
    return;
  }
  if (op === 3) {
    if (m === 9) sdkMode = false;
    const t = s.timers.get(m);
    if (t) { clearInterval(t); s.timers.delete(m); }
    reply(0);
  }
}

function startPmd(id, s, m, rate) {
  if (s.timers.has(m)) clearInterval(s.timers.get(m));
  const startS = nowS();
  let sent = 0;
  const perFrame = m === 1 ? 18 : 36;
  s.timers.set(m, setInterval(() => {
    const due = Math.floor((nowS() - startS) * rate) - sent;
    if (due < perFrame) return;
    const n = Math.min(due, perFrame), bytesPer = m === 1 ? 12 : 6;
    const f = new DataView(new ArrayBuffer(10 + n * bytesPer));
    const lastT = startS + (sent + n - 1) / rate;
    f.setUint8(0, m);
    f.setBigUint64(1, polarNs0 + BigInt(Math.round(lastT * 1e9)), true);
    f.setUint8(9, m === 1 ? 0 : 1);
    for (let i = 0; i < n; i++) {
      const t = startS + (sent + i) / rate;
      if (m === 1) {
        const base = -520000 - 3000 * pulse(t) + 800 * Math.sin(2 * Math.PI * 0.25 * t);
        [base, base - 1500, base - 2500, -456000].forEach((v, k) => {
          const x = Math.round(v + 30 * sleepRand()) & 0xffffff;
          f.setUint8(10 + 12 * i + 3 * k, x & 0xff); f.setUint8(11 + 12 * i + 3 * k, (x >> 8) & 0xff); f.setUint8(12 + 12 * i + 3 * k, (x >> 16) & 0xff);
        });
      } else {
        const tap = tapAccel(t) * 1000;
        [20 + 8 * sleepRand(), -30 + 8 * sleepRand(), 1000 + tap + 8 * sleepRand()].forEach((v, k) => f.setInt16(10 + 6 * i + 2 * k, Math.round(v), true));
      }
    }
    notify(id, 'data', new Uint8Array(f.buffer));
    sent += n;
  }, 25));
}

export function write(id, which, data) {
  const s = sims.get(id);
  if (!s?.connected) return Promise.reject(new Error('Not connected.'));
  const bytes = new Uint8Array(data);
  if (which === 'cmd') gspCommand(id, bytes); else pmdCommand(id, bytes);
  return new Promise(r => setTimeout(r, 8));
}

export function readHex(id, which) {
  // PMD features: PPG and ACC (byte 1 bit mask, as a Verity Sense reports them).
  return Promise.resolve('0f06' + '00'.repeat(15));
}
