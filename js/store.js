// The browser's own copy of a recording while it is made (Services/RecordingStore.cs). Files are mirrored into the
// origin private file system (OPFS) under recordings/<folder>/ by a worker (store-worker.js); if the tab is closed or
// crashes, the next visit finds them and offers to recover the recording. A Web Lock per folder marks the folders a
// live tab is still writing, so another tab never offers those.

let worker = null, nextId = 1, probed = null;
const pending = new Map();
const held = new Map();     // lock name -> release function
const staged = new Map();   // "dir/name" -> Uint8Array, read back for recovery

const lockName = dir => `movesensegsp-rec-${dir}`;

function call(message, transfer = []) {
  worker ??= (() => {
    const w = new Worker(new URL('./store-worker.js', import.meta.url));
    w.onmessage = e => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (!p) return;
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
    };
    w.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'storage worker failed')); pending.clear(); };
    return w;
  })();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

/** True when this browser can keep a recording in its private storage as it is made. */
export async function available() {
  if (probed !== null) return probed;
  try {
    probed = !!(navigator.storage?.getDirectory) && typeof Worker !== 'undefined' && !!navigator.locks && await call({ op: 'probe' });
  } catch (err) {
    console.warn('OPFS probe', err);
    probed = false;
  }
  return probed;
}

/** Holds the folder's lock until release() or deleteDir(), and asks the browser not to evict this site's storage. */
export async function lock(dir) {
  const name = lockName(dir);
  if (held.has(name)) return;
  await new Promise(acquired => {
    navigator.locks.request(name, () => new Promise(release => { held.set(name, release); acquired(); }));
  });
  try { await navigator.storage.persist?.(); } catch { }
}

export function release(dir) {
  const name = lockName(dir);
  held.get(name)?.();
  held.delete(name);
}

// Writes are queued without waiting (the bytes are copied during the call); settled() waits for all of them and
// returns the first error since the previous settled() ('' when none).
let lastWrite = Promise.resolve(), writeError = '';
function queue(message, transfer) {
  lastWrite = call(message, transfer).then(() => { }, err => { writeError ||= err.message; });
}

/** Appends bytes at offset. */
export function append(dir, name, offset, bytes) {
  const copy = bytes.slice();
  queue({ op: 'append', dir, name, offset, bytes: copy }, [copy.buffer]);
}

/** Replaces a whole file. */
export function writeWhole(dir, name, bytes) {
  const copy = bytes.slice();
  queue({ op: 'whole', dir, name, bytes: copy }, [copy.buffer]);
}

export function writeText(dir, name, text) {
  const bytes = new TextEncoder().encode(text);
  queue({ op: 'whole', dir, name, bytes }, [bytes.buffer]);
}

export function remove(dir, name) { queue({ op: 'remove', dir, name }, []); }

export async function settled() {
  await lastWrite;
  const e = writeError;
  writeError = '';
  return e;
}

export function closeDir(dir) { return call({ op: 'close', dir }); }

export async function deleteDir(dir) {
  await call({ op: 'deleteDir', dir });
  release(dir);
}

/**
 * The recordings kept in this browser that no live tab holds, as JSON: [{ dir, session, files: [{ name, size }] }].
 * session is the text of _web_session.json ('' when missing).
 */
export async function list() {
  if (!(await available())) return '[]';
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings', { create: true });
  const busy = new Set(((await navigator.locks.query()).held ?? []).map(l => l.name));
  const out = [];
  for await (const [dir, d] of root.entries()) {
    if (d.kind !== 'directory' || busy.has(lockName(dir)) && !held.has(lockName(dir))) continue;
    const files = [];
    let session = '';
    for await (const [name, f] of d.entries()) {
      if (f.kind !== 'file') continue;
      const file = await f.getFile();
      if (name === '_web_session.json') session = await file.text();
      else files.push({ name, size: file.size });
    }
    out.push({ dir, session, files });
  }
  return JSON.stringify(out);
}

/** Reads one stored file into the staging area; returns its size. copyStaged then copies it out in pieces. */
export async function readFile(dir, name) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings');
  const file = await (await (await root.getDirectoryHandle(dir)).getFileHandle(name)).getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  staged.set(`${dir}/${name}`, bytes);
  return bytes.length;
}

export function copyStaged(dir, name, offset, dest) {
  const bytes = staged.get(`${dir}/${name}`);
  dest.set(bytes.subarray(offset, offset + dest.length));
}

export function dropStaged(dir, name) { staged.delete(`${dir}/${name}`); }

/** Space this site uses and may use, MB, as "used/quota" (for the log). */
export async function estimate() {
  try {
    const e = await navigator.storage.estimate();
    return `${(e.usage / 1e6).toFixed(0)} MB used of ${(e.quota / 1e6).toFixed(0)} MB`;
  } catch { return ''; }
}
