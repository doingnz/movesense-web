// Writes recordings into the origin private file system (OPFS) as they are made, for wwwroot/js/store.js. A dedicated
// worker because only workers get synchronous access handles, which write in place: appending a second of data costs
// that second's bytes, and what is flushed survives a closed or crashed tab. Messages run one at a time, in order.

let root = null;
const handles = new Map(); // "dir/name" -> FileSystemSyncAccessHandle

async function recordings() {
  root ??= await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings', { create: true });
  return root;
}

async function handle(dir, name) {
  const key = `${dir}/${name}`;
  let h = handles.get(key);
  if (!h) {
    const d = await (await recordings()).getDirectoryHandle(dir, { create: true });
    const f = await d.getFileHandle(name, { create: true });
    h = await f.createSyncAccessHandle();
    handles.set(key, h);
  }
  return h;
}

function closeDir(dir) {
  for (const [key, h] of handles) {
    if (key.startsWith(`${dir}/`)) { try { h.close(); } catch { } handles.delete(key); }
  }
}

async function run(m) {
  switch (m.op) {
    case 'probe':
      return typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype;
    case 'append': {
      const h = await handle(m.dir, m.name);
      h.write(m.bytes, { at: m.offset });
      h.flush();
      return h.getSize();
    }
    case 'whole': {
      const h = await handle(m.dir, m.name);
      h.truncate(0);
      h.write(m.bytes, { at: 0 });
      h.flush();
      return m.bytes.byteLength;
    }
    case 'remove': {
      const key = `${m.dir}/${m.name}`;
      handles.get(key)?.close();
      handles.delete(key);
      const d = await (await recordings()).getDirectoryHandle(m.dir, { create: true });
      try { await d.removeEntry(m.name); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      return 0;
    }
    case 'close':
      closeDir(m.dir);
      return 0;
    case 'deleteDir':
      closeDir(m.dir);
      try { await (await recordings()).removeEntry(m.dir, { recursive: true }); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      return 0;
    default:
      throw new Error(`unknown op ${m.op}`);
  }
}

let chain = Promise.resolve();
self.onmessage = e => {
  const m = e.data;
  chain = chain.then(() => run(m)).then(
    result => self.postMessage({ id: m.id, ok: true, result }),
    err => self.postMessage({ id: m.id, ok: false, error: `${err?.name ?? 'Error'}: ${err?.message ?? err}` }));
};
