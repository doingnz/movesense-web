// Saving a finished recording from the browser's memory: into a folder the user picks (File System Access API, Chrome
// and Edge on desktops) or as a downloaded zip. .NET stages each file's bytes here first (Interop/FilesInterop.cs).

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
