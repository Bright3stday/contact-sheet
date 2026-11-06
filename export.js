// Exports: annotated sheets (one JPEG each + one PDF), a picks list, the Picks folder copy
// and sharing a picked frame (tablet).
import { SHEET_W, SHEET_H, drawSheet, getBitmap, decodeThumb } from './sheet.js';

const JPEG_QUALITY = 0.9;
const A4 = [297, 210];   // mm, landscape

// layouts: [{ name: 'rated' | 'all', sheets: [{ sheet, trailingSkip, marks }] }].
// picks: frames in sequence order. folder: the shoot folder handle (PC) or null (tablet:
// everything downloads). progress(text, fraction 0..1 or null). Returns a summary for the user.
export async function exportAll({ layouts, picks, folder, baseName, progress }) {
  const out = folder ? await folder.getDirectoryHandle('Picks', { create: true }) : null;
  const save = (name, blob) => out ? writeFile(out, name, blob) : download(name, blob);
  const lines = [];

  if (out) {
    const r = await copyPicks(picks, out, progress);
    lines.push(`Copied ${r.copied.length} JPEGs to Picks. RAWs stay in the shoot folder.`);
    if (r.rawOnly.length) lines.push(`RAW only, listed in the picks file: ${r.rawOnly.join(', ')}`);
    if (r.skipped.length) lines.push(`Already in Picks, left as is: ${r.skipped.join(', ')}`);
    if (r.clashes.length) lines.push(`A different file with this name is already in Picks, not copied: ${r.clashes.join(', ')}`);
    if (r.failed.length) lines.push(`COPY FAILED, nothing left behind: ${r.failed.join(', ')}`);
    if (r.missing.length) lines.push(`Not found in this folder: ${r.missing.join(', ')}`);
  }

  await save(`${baseName}-picks.txt`, new Blob([picksText(picks)], { type: 'text/plain' }));

  const { jsPDF } = await loadJsPdf();
  const total = layouts.reduce((n, l) => n + l.sheets.length, 0);
  let done = 0;
  for (const { name, sheets } of layouts) {
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    for (let i = 0; i < sheets.length; i++) {
      progress?.(`Exporting ${name} sheet ${i + 1} / ${sheets.length}`, done++ / total);
      const blob = await renderSheet(sheets[i], sheets.length);
      await save(`${baseName}-${name}-sheet-${String(i + 1).padStart(2, '0')}.jpg`, blob);
      if (i) pdf.addPage();
      pdf.addImage(new Uint8Array(await blob.arrayBuffer()), 'JPEG', 0, 0, A4[0], A4[1]);
    }
    await save(`${baseName}-${name}.pdf`, pdf.output('blob'));
    const n = sheets.length;
    lines.push(`Saved ${n} ${name} sheet JPEG${n === 1 ? '' : 's'} and ${baseName}-${name}.pdf.`);
  }
  progress?.('', null);

  lines.push(`Saved ${baseName}-picks.txt. Everything is ${out ? 'in Picks' : 'in Downloads'}.`);
  return lines.join('\n');
}

// Full-resolution sheet through the same drawSheet as the screen. Uses cached thumbnails
// where they exist and decodes (then releases) the rest.
async function renderSheet({ sheet, trailingSkip, marks }, sheetCount) {
  const own = new Map();
  for (const { frame } of sheet.cells) {
    if (getBitmap(frame) || !(frame.jpg || frame.raw)) continue;
    try { own.set(frame, await decodeThumb(frame)); } catch (e) { console.warn('decode failed', frame.name, e); }
  }
  const canvas = new OffscreenCanvas(SHEET_W, SHEET_H);
  drawSheet(canvas.getContext('2d'), sheet, sheetCount, trailingSkip, f => getBitmap(f) || own.get(f) || null, marks);
  for (const bm of own.values()) bm.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}

// One filename per line: each pick's JPEG and RAW (or its name from the marks file).
function picksText(picks) {
  const names = picks.flatMap(f => f.jpg || f.raw ? [f.jpg?.name, f.raw?.name].filter(Boolean) : [f.name]);
  return names.join('\r\n') + '\r\n';
}

// Copies picked JPEGs into Picks. RAWs stay in the shoot folder only, so storage isn't doubled;
// RAW-only picks are just listed. Never overwrites a real file: a copy of the same size counts
// as done, a different file of that name is left alone and reported. An empty file (left by an
// earlier copy that was cut off) is copied over. Progress follows bytes copied.
async function copyPicks(picks, out, progress) {
  const copied = [], skipped = [], clashes = [], failed = [], missing = [], rawOnly = [];
  const todo = [];
  for (const f of picks) {
    if (!f.jpg && !f.raw) { missing.push(f.name); continue; }
    if (!f.jpg) { rawOnly.push(f.raw.name); continue; }
    const size = await existingSize(out, f.jpg.name);
    if (size === f.jpg.size && size > 0) skipped.push(f.jpg.name);
    else if (size > 0) clashes.push(f.jpg.name);
    else todo.push(f.jpg);
  }
  const total = todo.reduce((n, f) => n + f.size, 0) || 1;
  let bytes = 0;
  for (const [i, file] of todo.entries()) {
    const label = `Copying ${i + 1} / ${todo.length}: ${file.name}`;
    try {
      await writeFile(out, file.name, file, n => progress?.(label, (bytes + n) / total));
      copied.push(file.name);
    } catch (e) {
      failed.push(`${file.name} (${e.message})`);
    }
    bytes += file.size;
  }
  return { copied, skipped, clashes, failed, missing, rawOnly };
}

// Move RAWs (folder mode, only when the user asks): each frame's RAW, with its DxO .dop and any
// .xmp, between the shoot folder and Picks. Only a true move: if the browser can't move files,
// nothing is copied or deleted. Never overwrites: a frame with any of its files already at the
// destination is left where it is and reported. Moved frames get their RAW from its new place.
export async function moveRaws(frames, folder, toPicks) {
  if (!('move' in FileSystemFileHandle.prototype)) throw new Error("This browser can't move files.");
  const picks = await folder.getDirectoryHandle('Picks', { create: true });
  const [from, to] = toPicks ? [folder, picks] : [picks, folder];
  const moved = [], clashes = [], failed = [];
  for (const f of frames) {
    const raw = f.raw.name, base = raw.replace(/\.[^.]+$/, '');
    const rawHandle = await fileHandle(from, raw);
    if (!rawHandle) { failed.push(`${raw} (not found)`); continue; }
    const handles = [rawHandle];
    for (const name of [`${raw}.dop`, `${raw}.xmp`, `${base}.xmp`]) {
      const h = await fileHandle(from, name);
      if (h) handles.push(h);
    }
    const there = [];
    for (const h of handles) if (await fileHandle(to, h.name)) there.push(h.name);
    if (there.length) { clashes.push(`${raw} (${there.join(', ')})`); continue; }
    try {
      for (const h of handles) await h.move(to);
      f.raw = Object.assign(await rawHandle.getFile(), { handle: rawHandle, inPicks: toPicks });
      moved.push(raw);
    } catch (e) {
      failed.push(`${raw} (${e.message})`);
    }
  }
  return { moved, clashes, failed };
}

async function fileHandle(dir, name) {
  try { return await dir.getFileHandle(name); } catch { return null; }
}

// Size of the file of that name in dir, or null if there is none.
async function existingSize(dir, name) {
  try { return (await (await dir.getFileHandle(name)).getFile()).size; } catch { return null; }
}

// Writes through a temporary file that only replaces the target on close. If anything fails,
// the write is aborted and a target this call created is removed, so no partial file is left.
async function writeFile(dir, name, blob, onBytes) {
  const created = await existingSize(dir, name) === null;
  const handle = await dir.getFileHandle(name, { create: true });
  let w;
  try {
    w = await handle.createWritable();
    if (onBytes && blob.stream) {
      const reader = blob.stream().getReader();
      let n = 0;
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        await w.write(r.value);
        onBytes(n += r.value.byteLength);
      }
    } else {
      await w.write(blob);
    }
    await w.close();
  } catch (e) {
    try { await w?.abort(); } catch {}
    if (created) { try { await dir.removeEntry(name); } catch {} }
    throw e;
  }
}

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Tablet: send an original file (JPEG or RAW) to the Android share sheet.
// Without Web Share (plain http) a JPEG falls back to a download. Chrome only shares some
// file types, so a RAW may be refused; the RAW is on the tablet already in that case.
export async function shareFile(file) {
  if (!file) return;
  const isRaw = !/\.jpe?g$/i.test(file.name);
  if (isRaw && !file.type) file = new File([file], file.name, { type: 'image/x-raw' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') alert('Share failed: ' + e.message); }
  } else if (isRaw) {
    alert(`This browser won't share ${file.name}. Open it from Snapseed's own file picker instead.`);
  } else {
    download(file.name, file);
  }
}

let jsPdfLoading = null;
function loadJsPdf() {
  return jsPdfLoading || (jsPdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/jspdf.umd.min.js';
    s.onload = () => resolve(window.jspdf);
    s.onerror = () => { jsPdfLoading = null; reject(new Error('jsPDF failed to load')); };
    document.head.append(s);
  }));
}
