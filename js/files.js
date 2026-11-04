// Saving a finished recording from the browser's memory: into a folder the user picks (File System Access API, Chrome
// and Edge on desktops), through the share sheet (iPhone: Bluefy has no downloads) or as a downloaded zip. .NET stages
// each file's bytes here first (Interop/FilesInterop.cs).

const staged = new Map(); // name -> Uint8Array
let folder = null;        // the picked FileSystemDirectoryHandle, reused for later saves

export function canPickFolder() {
  return 'showDirectoryPicker' in window;
}

/** The picked folder's name, or '' when none has been picked yet. */
export function folderName() {
  return folder?.name ?? '';
}

/** Asks for the folder recordings go into (needs a click: call it first in the click handler). */
export async function pickFolder() {
  folder = await window.showDirectoryPicker({ id: 'movesensegsp-recordings', mode: 'readwrite', startIn: 'documents' });
  return folder.name;
}

export function stage(name, data) {
  staged.set(name, data.slice());
}

export function clearStaged() {
  staged.clear();
}

/** Writes the staged files into <picked folder>/<subfolder>/; returns that path for display. */
export async function writeStaged(subfolder) {
  if (!folder) throw new Error('No folder picked.');
  if ((await folder.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
      (await folder.requestPermission({ mode: 'readwrite' })) !== 'granted')
    throw new Error('The browser was not allowed to write to that folder.');
  const dir = await folder.getDirectoryHandle(subfolder, { create: true });
  for (const [name, bytes] of staged) {
    const file = await dir.getFileHandle(name, { create: true });
    const w = await file.createWritable();
    await w.write(bytes);
    await w.close();
  }
  staged.clear();
  return `${folder.name}/${subfolder}`;
}

/** The browser's own description (for the log). */
export function userAgent() {
  return navigator.userAgent;
}

/** Downloads a text file (the log). */
export function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---- The share sheet (iPhone and iPad: Save to Files, AirDrop, Mail) ----
// A page can only open the share sheet from a tap. .NET packs the zip inside the click handler and opens the sheet
// at once; if the browser decides the tap has expired by then ('needs-tap'), the zip stays staged and the next tap
// on the button (data-share-file="<name>") opens the sheet from this listener, before .NET sees the click.

const mimeOf = name => name.endsWith('.zip') ? 'application/zip' : name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream';
let shareRun = null; // { name, promise, taken }: the share a tap started

/** True when the browser can hand a zip to the share sheet. */
export function canShareFiles() {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([new Uint8Array(1)], 'test.zip', { type: 'application/zip' })] });
  } catch {
    return false;
  }
}

export function stageText(name, text) {
  staged.set(name, new TextEncoder().encode(text));
}

export function isStaged(name) {
  return staged.has(name);
}

export function dropStaged(name) {
  staged.delete(name);
}

function startShare(name, fromTap) {
  const file = new File([staged.get(name)], name, { type: mimeOf(name) });
  const run = { name, taken: false, promise: null };
  run.promise = (async () => {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      if (e?.name === 'NotAllowedError' && !fromTap) return 'needs-tap';
      return `failed: ${e?.name ?? 'Error'}: ${e?.message ?? e}`;
    }
  })();
  shareRun = run;
  return run;
}

document.addEventListener('click', e => {
  const name = e.target?.closest?.('[data-share-file]')?.dataset.shareFile;
  if (name && staged.has(name)) startShare(name, true);
}, true);

/** True when this click already opened the share sheet for the staged file (from the listener above). */
export function shareStarted(name) {
  return shareRun?.name === name && !shareRun.taken;
}

/** The outcome of the share the listener started: 'shared', 'cancelled' or 'failed: ...'. */
export function takeShare() {
  const run = shareRun;
  if (!run || run.taken) return Promise.resolve('failed: no share was started');
  run.taken = true;
  return run.promise;
}

/** Opens the share sheet for a staged file now (call it inside a click handler); 'needs-tap' when the tap expired. */
export function shareStaged(name) {
  if (!staged.has(name)) return Promise.resolve(`failed: nothing staged as ${name}`);
  const run = startShare(name, false);
  run.taken = true;
  return run.promise;
}

/** Downloads one staged file (the zip) and forgets it. */
export function downloadStaged(name) {
  const bytes = staged.get(name);
  if (!bytes) throw new Error(`Nothing staged as ${name}.`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  staged.delete(name);
}
