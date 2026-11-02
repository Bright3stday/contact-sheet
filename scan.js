// Open a folder or a set of files, group JPEG/RAW into frames, read header metadata and sort.
import exifr from './vendor/exifr.mjs';

const HEAD_BYTES = 131072;   // all needed metadata sits in the first 128 KB (checked on the samples)
const SHEET_PREVIEW_MAX = 1048576;
const SCAN_PARALLEL = 4;

const JPEG_EXT = ['jpg', 'jpeg'];
const RAW_EXT = ['arw', 'raf'];

// Basename, case-insensitive, without a trailing _<digits> (Creators' App adds "_1").
export function frameKey(name) {
  return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/_\d+$/, '');
}

function ext(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

// Folder mode: top level of the picked folder.
export async function filesFromFolder(dir) {
  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && isImage(entry.name)) files.push(await entry.getFile());
  }
  return groupFiles(files);
}

// Files mode: the selected files.
export function filesFromInput(fileList) {
  return groupFiles([...fileList]);
}

function isImage(name) {
  return JPEG_EXT.includes(ext(name)) || RAW_EXT.includes(ext(name));
}

// JPEG and RAW sharing a key form one frame.
function groupFiles(files) {
  const groups = new Map();
  for (const f of files) {
    if (!isImage(f.name)) continue;
    const key = frameKey(f.name);
    if (!groups.has(key)) groups.set(key, { key, jpg: null, raw: null });
    groups.get(key)[JPEG_EXT.includes(ext(f.name)) ? 'jpg' : 'raw'] = f;
  }
  return [...groups.values()];
}

// Reads metadata (and RAW preview locations) for every frame, then sorts by capture time, then filename.
export async function scanFrames(groups, onProgress) {
  const frames = groups.map(g => ({
    key: g.key,
    name: (g.jpg || g.raw).name,
    jpg: g.jpg,
    raw: g.raw,
    rating: 0,
    time: '',        // "YYYY:MM:DD HH:MM:SS"
    subsec: '',
    orientation: 1,
    previews: null,  // RAW-only frames: { sheet: {offset, length}, full: {offset, length} }
  }));

  let next = 0, done = 0;
  async function worker() {
    while (next < frames.length) {
      const f = frames[next++];
      try { await readFrame(f); } catch (e) { console.warn('scan failed', f.name, e); }
      onProgress?.(++done, frames.length);
    }
  }
  await Promise.all(Array.from({ length: SCAN_PARALLEL }, worker));

  frames.sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.name.localeCompare(b.name));
  return frames;
}

function sortKey(f) {
  return f.time ? f.time + '.' + f.subsec.padEnd(3, '0') : '9999';
}

// With a RAW present, metadata and the sheet image both come from the RAW header and its
// small embedded preview: far less to read from a slow HDD than a full JPEG.
async function readFrame(f) {
  let head;
  if (!f.raw) {
    head = await f.jpg.slice(0, HEAD_BYTES).arrayBuffer();
  } else {
    head = await f.raw.slice(0, HEAD_BYTES).arrayBuffer();
    f.previews = ext(f.raw.name) === 'raf' ? rafPreviews(head) : await tiffPreviews(f.raw, head);
    if (ext(f.raw.name) === 'raf') {
      // exifr does not read RAF; its metadata lives in the embedded JPEG.
      const p = f.previews.full;
      head = await f.raw.slice(p.offset, p.offset + HEAD_BYTES).arrayBuffer();
    }
  }
  const m = await exifr.parse(head, {
    xmp: true, mergeOutput: false, translateValues: false, reviveValues: false,
    ifd1: false, gps: false, interop: false,
  });
  if (!m) return;
  f.rating = Number(m.xmp?.Rating ?? m.ifd0?.Rating ?? 0) || 0;
  f.time = m.exif?.DateTimeOriginal || m.ifd0?.DateTime || '';
  f.subsec = String(m.exif?.SubSecTimeOriginal ?? '').trim();
  f.orientation = m.ifd0?.Orientation || 1;
}

// RAF header: big-endian offset/length of the embedded JPEG at bytes 84/88.
function rafPreviews(head) {
  const v = new DataView(head);
  const p = { offset: v.getUint32(84), length: v.getUint32(88) };
  return { sheet: p, full: p };
}

// ARW (TIFF): collect JPEGInterchangeFormat (0x0201/0x0202) along the IFD chain.
// Later IFDs can sit past the header slice; those are read with a small extra slice.
async function tiffPreviews(file, head) {
  const le = new DataView(head).getUint16(0) === 0x4949;
  const found = [];
  let off = new DataView(head).getUint32(4, le);
  for (let guard = 0; off && off < file.size && guard < 8; guard++) {
    let v = new DataView(head), base = 0;
    if (off + 4096 > head.byteLength) {
      v = new DataView(await file.slice(off, off + 4096).arrayBuffer());
      base = off;
    }
    const n = v.getUint16(off - base, le);
    let jo = 0, jl = 0;
    for (let i = 0; i < n; i++) {
      const e = off - base + 2 + i * 12;
      const tag = v.getUint16(e, le);
      if (tag === 0x0201) jo = v.getUint32(e + 8, le);
      if (tag === 0x0202) jl = v.getUint32(e + 8, le);
    }
    if (jo && jl) found.push({ offset: jo, length: jl });
    off = v.getUint32(off - base + 2 + n * 12, le);
  }
  if (!found.length) throw new Error('no embedded preview');
  found.sort((a, b) => a.length - b.length);
  const full = found[found.length - 1];
  const sheet = found.filter(p => p.length <= SHEET_PREVIEW_MAX).pop() || full;
  return { sheet, full };
}

// The JPEG to display. Sheet: the RAW's embedded preview when there is a RAW, else the JPEG.
// Full size (loupe): the JPEG when there is one, else the RAW's largest preview.
export function frameBlob(frame, size) {
  if (!frame.previews || (size === 'full' && frame.jpg)) return frame.jpg;
  const p = frame.previews[size];
  return frame.raw.slice(p.offset, p.offset + p.length, 'image/jpeg');
}
