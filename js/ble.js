// Web Bluetooth for the web app: the Movesense (GSP service) and a Polar band (PMD service). Each device is picked once
// per page load with the browser's chooser; reconnects reuse the device object, so they need no chooser. Notifications
// go straight to .NET (Interop/BleInterop.cs, [JSExport]), where the desktop's protocol code parses them.
// UUIDs: PROTOCOL.md §1 (GSP) and src/MovesenseGsp.Core/Polar/PmdProtocol.cs (PMD).

const GSP = {
  service: '34802252-7185-4d5d-b431-630e7050e8f0',
  cmd: '34800001-7185-4d5d-b431-630e7050e8f0',
  data: '34800002-7185-4d5d-b431-630e7050e8f0',
};
const PMD = {
  service: 'fb005c80-02e7-f387-1cad-8acd2d8df0c8',
  cp: 'fb005c81-02e7-f387-1cad-8acd2d8df0c8',
  data: 'fb005c82-02e7-f387-1cad-8acd2d8df0c8',
};
const POLAR_COMPANY_ID = 0x006b;

import * as sim from './sim.js';
const isSim = id => id.startsWith('sim-');

const devices = new Map(); // id -> { device, kind, chars, queue, intentional }
let dotnet = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bytes = dv => new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');

async function bindDotnet() {
  if (dotnet) return dotnet;
  const runtime = await globalThis.getDotnetRuntime(0);
  const exports = await runtime.getAssemblyExports('MovesenseGsp.Web.dll');
  dotnet = exports.MovesenseGsp.Web.Interop.BleInterop;
  return dotnet;
}

export function available() {
  return !!navigator.bluetooth;
}

/** The browser's chooser, or a simulated sensor (sim.js). Returns "id\nname". kind: 'movesense' or 'polar'. */
export async function pick(kind, simulated) {
  await bindDotnet();
  if (simulated) {
    sim.bind(dotnet);
    return sim.pick(kind);
  }
  const options = kind === 'movesense'
    ? { filters: [{ namePrefix: 'Movesense' }], optionalServices: [GSP.service] }
    // A Polar band bound to a phone or PC may advertise without a name: match Polar's company ID too.
    : { filters: [{ namePrefix: 'Polar' }, { manufacturerData: [{ companyIdentifier: POLAR_COMPANY_ID }] }], optionalServices: [PMD.service] };
  const device = await navigator.bluetooth.requestDevice(options);
  let e = devices.get(device.id);
  if (!e) {
    e = { device, kind, chars: {}, queue: Promise.resolve(), intentional: false };
    devices.set(device.id, e);
    device.addEventListener('gattserverdisconnected', () => {
      if (e.intentional) { e.intentional = false; return; }
      try { dotnet.OnDisconnected(device.id); } catch (err) { console.error(err); }
    });
  }
  return `${device.id}\n${device.name ?? ''}`;
}

const hooked = new WeakSet();
function hook(characteristic, handler) {
  if (hooked.has(characteristic)) return;
  hooked.add(characteristic);
  characteristic.addEventListener('characteristicvaluechanged', ev => {
    try { handler(bytes(ev.target.value)); } catch (err) { console.error(err); }
  });
}

/**
 * Connects, finds the service and turns on notifications. Retried up to 3 times: a connect soon after a disconnect can
 * resolve at once and then drop, while Windows is still closing the old link (WEBAPP_PLAN.md, spike S4).
 */
export async function connect(id) {
  if (isSim(id)) return sim.connect(id);
  const e = devices.get(id);
  if (!e) throw new Error('Unknown device: pick it first.');
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const server = await e.device.gatt.connect();
      if (e.kind === 'movesense') {
        const svc = await server.getPrimaryService(GSP.service);
        e.chars.cmd = await svc.getCharacteristic(GSP.cmd);
        e.chars.data = await svc.getCharacteristic(GSP.data);
        hook(e.chars.data, v => dotnet.OnGspNotification(id, v));
        await e.chars.data.startNotifications();
      } else {
        const svc = await server.getPrimaryService(PMD.service);
        e.chars.cp = await svc.getCharacteristic(PMD.cp);
        e.chars.data = await svc.getCharacteristic(PMD.data);
        hook(e.chars.cp, v => dotnet.OnPmdControl(id, v));
        hook(e.chars.data, v => dotnet.OnPmdData(id, v));
        await e.chars.cp.startNotifications();
        await e.chars.data.startNotifications();
      }
      if (!e.device.gatt.connected) throw new Error('The link dropped during the setup.');
      e.queue = Promise.resolve();
      return;
    } catch (err) {
      last = err;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw last;
}

/** Writes with response, one GATT operation at a time per device (Chrome rejects overlapping ones). */
export function write(id, which, data) {
  if (isSim(id)) return sim.write(id, which, data);
  const e = devices.get(id);
  const run = () => {
    const c = e?.chars[which];
    if (!c || !e.device.gatt.connected) throw new Error('Not connected.');
    return c.writeValueWithResponse(new Uint8Array(data));
  };
  const p = e.queue.then(run, run);
  e.queue = p.catch(() => {});
  return p;
}

/** Reads a characteristic; returns its value as hex. */
export function readHex(id, which) {
  if (isSim(id)) return sim.readHex(id, which);
  const e = devices.get(id);
  const run = async () => hex(bytes(await e.chars[which].readValue()));
  const p = e.queue.then(run, run);
  e.queue = p.catch(() => {});
  return p;
}

export function disconnect(id) {
  if (isSim(id)) return sim.disconnect(id);
  const e = devices.get(id);
  if (!e || !e.device.gatt.connected) return;
  e.intentional = true;
  e.device.gatt.disconnect();
}

export function isConnected(id) {
  if (isSim(id)) return sim.isConnected(id);
  return !!devices.get(id)?.device.gatt.connected;
}

/** For tests: a simulated sensor's link drops. */
export function simDrop(id) {
  sim.drop(id);
}

// ---------------- page helpers ----------------

let wakeLock = null, wantWake = false, leaveWarning = false;

/** Keeps the screen (and so the PC) awake while connected; re-taken when the page becomes visible again. */
export async function keepAwake(on) {
  wantWake = on;
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) { console.warn('wake lock', err); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wantWake) keepAwake(true); });

/** Asks before the tab is closed or reloaded (a reload drops the links and loses an unsaved recording). */
export function setLeaveWarning(on) {
  leaveWarning = on;
}
window.addEventListener('beforeunload', ev => { if (leaveWarning) { ev.preventDefault(); ev.returnValue = ''; } });
