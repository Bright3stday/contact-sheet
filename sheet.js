// Sheet layout, the one sheet renderer (screen and export), and the bitmap cache.
import { frameBlob } from './scan.js';

// Sheet coordinates = A4 landscape at 300 dpi. Strokes and layout use these units.
export const SHEET_W = 3508;
export const SHEET_H = 2480;
export const COLS = 6;
export const ROWS = 6;
export const PER_SHEET = COLS * ROWS;

const CELL_W = 480;          // 3:2 image box
const CELL_H = 320;
const GAP_X = 60;
const LABEL_H = 48;
const ROW_PITCH = 384;
const LEFT = (SHEET_W - (COLS * CELL_W + (COLS - 1) * GAP_X)) / 2;
const TOP = 110;

const COLOR = {
  sheet: '#141414',
  frame: '#000',
  empty: '#222',
  label: '#d9b25f',
  header: '#999',
  skip: '#777',
  mark: '#e01b1b',
};
const MARK_ALPHA = 0.65;
const PEN_W = 9;
const BOX_W = 8;
const PICK_W = 10;
const RATED_CORNER = 44;
const FONT = '"Courier New", monospace';

// Image box of cell i (0..35) in sheet coordinates.
export function cellRect(i) {
  const col = i % COLS, row = Math.floor(i / COLS);
  return { x: LEFT + col * (CELL_W + GAP_X), y: TOP + row * ROW_PITCH, w: CELL_W, h: CELL_H };
}

// Cell index under a point in sheet coordinates (image box or its label), or -1.
export function cellAt(x, y) {
  for (let i = 0; i < PER_SHEET; i++) {
    const r = cellRect(i);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h + LABEL_H) return i;
  }
  return -1;
}

// Splits the visible frames into sheets. Each cell carries its frame, its number in the full
// sequence, and how many hidden (unrated) frames were skipped just before it.
export function buildSheets(visible) {
  const sheets = [];
  for (let i = 0; i < visible.length; i += PER_SHEET) {
    sheets.push({ index: sheets.length, cells: visible.slice(i, i + PER_SHEET) });
  }
  return sheets;
}

// Draws one sheet. The caller sets the transform from sheet units to canvas pixels.
// getBitmap(frame) returns an ImageBitmap or null while it is still loading.
// marks: { picks: Set of frame keys, items: pen/box items of this sheet }.
export function drawSheet(ctx, sheet, sheetCount, trailingSkip, getBitmap, marks) {
  ctx.fillStyle = COLOR.sheet;
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLOR.header;
  ctx.font = `32px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`SHEET ${sheet.index + 1} / ${sheetCount}`, LEFT, 70);
  const days = [...new Set(sheet.cells.map(c => formatDate(c.frame.time)).filter(Boolean))];
  if (days.length) {
    ctx.textAlign = 'center';
    ctx.fillText(days.length === 1 ? days[0] : `${days[0]} – ${days[days.length - 1]}`, SHEET_W / 2, 70);
  }
  if (sheet.cells.length) {
    const first = sheet.cells[0].number, last = sheet.cells[sheet.cells.length - 1].number;
    ctx.textAlign = 'right';
    ctx.fillText(`#${first} – #${last}`, SHEET_W - LEFT, 70);
  }

  sheet.cells.forEach((cell, i) => {
    const r = cellRect(i);
    drawFrame(ctx, r, getBitmap(cell.frame));
    if (cell.frame.rating > 0) drawRated(ctx, r);
    drawLabel(ctx, r, cell);
    if (cell.skippedBefore) drawSkip(ctx, r.x - GAP_X / 2, r.y, cell.skippedBefore);
  });

  if (trailingSkip) {
    const r = cellRect(sheet.cells.length - 1);
    drawSkip(ctx, r.x + r.w + GAP_X / 2, r.y, trailingSkip);
  }

  drawMarks(ctx, sheet, marks);
}

// Grease pencil: all marks go on one opaque layer that is laid over the sheet
// semi-transparently, so overlapping strokes don't build up darker.
// One layer per target canvas (screen, magnifier, export).
const layers = new WeakMap();

function drawMarks(ctx, sheet, marks) {
  const { width, height } = ctx.canvas;
  let layer = layers.get(ctx.canvas);
  if (!layer || layer.width !== width || layer.height !== height) layers.set(ctx.canvas, layer = new OffscreenCanvas(width, height));
  const g = layer.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, width, height);
  g.setTransform(ctx.getTransform());
  g.strokeStyle = COLOR.mark;
  g.lineCap = g.lineJoin = 'round';

  sheet.cells.forEach((cell, i) => {
    if (!marks.picks.has(cell.frame.key)) return;
    const r = cellRect(i), m = 16;
    g.lineWidth = PICK_W;
    g.beginPath();
    g.roundRect(r.x - m, r.y - m, r.w + 2 * m, r.h + 2 * m, 90);
    g.stroke();
  });

  for (const it of marks.items) {
    if (it.type === 'box') {
      g.lineWidth = BOX_W;
      g.strokeRect(it.x, it.y, it.w, it.h);
      continue;
    }
    const pts = it.points, w = PEN_W * (it.size ?? 1);
    for (let i = 1; i < pts.length; i++) {
      g.lineWidth = w * (0.3 + 1.4 * pts[i][2]);
      g.beginPath();
      g.moveTo(pts[i - 1][0], pts[i - 1][1]);
      g.lineTo(pts[i][0], pts[i][1]);
      g.stroke();
    }
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = MARK_ALPHA;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

function drawFrame(ctx, r, bitmap) {
  ctx.fillStyle = bitmap ? COLOR.frame : COLOR.empty;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (!bitmap) return;
  const s = Math.min(r.w / bitmap.width, r.h / bitmap.height);
  const w = bitmap.width * s, h = bitmap.height * s;
  ctx.drawImage(bitmap, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
}

function drawLabel(ctx, r, cell) {
  const y = r.y + r.h + 32;
  ctx.fillStyle = COLOR.label;
  ctx.font = `bold 24px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(String(cell.number), r.x, y);
  ctx.font = `22px ${FONT}`;
  ctx.fillText(cell.frame.name, r.x + 70, y, r.w - 190);
  ctx.textAlign = 'right';
  ctx.fillText(cell.frame.time.slice(11, 19), r.x + r.w, y);
}

// Rated in camera: gold corner lines just outside the image, so frames that caught the eye
// stand out in All frames too without covering any of the picture. They sit inside the pick outline.
function drawRated(ctx, r) {
  const m = 7, L = RATED_CORNER;
  const x0 = r.x - m, y0 = r.y - m, x1 = r.x + r.w + m, y1 = r.y + r.h + m;
  ctx.strokeStyle = COLOR.label;
  ctx.lineWidth = 5;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    ctx.moveTo(x + dx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * L);
  }
  ctx.stroke();
}

// "2026:11:01 18:44:15" -> "1 Nov 2026"
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(time) {
  const [y, m, d] = time.slice(0, 10).split(':').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : '';
}

// Thin divider with a count where unrated frames were skipped.
function drawSkip(ctx, x, y, count) {
  ctx.strokeStyle = COLOR.skip;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + CELL_H);
  ctx.stroke();
  ctx.fillStyle = COLOR.sheet;
  ctx.fillRect(x - GAP_X / 2 + 2, y + CELL_H / 2 - 20, GAP_X - 4, 36);
  ctx.fillStyle = COLOR.skip;
  ctx.font = `22px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(`+${count}`, x, y + CELL_H / 2 + 7);
}

// ---- Bitmap cache: only frames of the current sheet and its neighbours stay decoded ----

const DECODE_PARALLEL = 3;
const cache = new Map();   // frame -> ImageBitmap
let wanted = new Set();
let queue = [];
let running = 0;
let onReady = () => {};

export function getBitmap(frame) {
  return sharp.get(frame)?.bm || cache.get(frame) || null;
}

// frames: in priority order (current sheet first). Everything else is released.
export function keepBitmaps(frames, ready) {
  onReady = ready;
  wanted = new Set(frames);
  for (const [frame, bm] of cache) {
    if (!wanted.has(frame)) { bm.close(); cache.delete(frame); }
  }
  queue = frames.filter(f => !cache.has(f) && (f.jpg || f.raw));   // marks-file placeholders have no file
  pump();
}

function pump() {
  while (running < DECODE_PARALLEL && queue.length) {
    const frame = queue.shift();
    if (cache.has(frame) || !wanted.has(frame)) continue;
    running++;
    decodeThumb(frame)
      .then(bm => {
        if (wanted.has(frame) && !cache.has(frame)) { cache.set(frame, bm); onReady(frame); }
        else bm.close();
      })
      .catch(e => console.warn('decode failed', frame.name, e))
      .finally(() => { running--; pump(); });
  }
}

// ---- Sharper decodes while zoomed in: only the frames in view, at about the size shown ----

const SHARP_PARALLEL = 2;
const SHARP_MAX_H = 1280;
const sharp = new Map();   // frame -> { bm, h }
let sharpH = 0;
let sharpWanted = new Set();
let sharpQueue = [];
let sharpRunning = 0;
let onSharp = () => {};

// scale: canvas pixels per sheet unit. Near 1 the normal thumbnails are already sharp,
// so nothing extra is kept. Heights go up in half-cell steps to avoid re-decoding on every pinch.
export function keepSharp(frames, scale, ready) {
  sharpH = scale > 1.15 ? Math.min(SHARP_MAX_H, Math.ceil(scale * 2) / 2 * CELL_H) : 0;
  onSharp = ready;
  sharpWanted = new Set(sharpH ? frames : []);
  for (const [frame, e] of sharp) {
    if (!sharpWanted.has(frame)) { e.bm.close(); sharp.delete(frame); }
  }
  sharpQueue = [...sharpWanted].filter(f => (f.jpg || f.raw) && !(sharp.get(f)?.h >= sharpH));
  pumpSharp();
}

function pumpSharp() {
  while (sharpRunning < SHARP_PARALLEL && sharpQueue.length) {
    const frame = sharpQueue.shift(), h = sharpH;
    sharpRunning++;
    decodeThumb(frame, h)
      .then(bm => {
        const old = sharp.get(frame);
        if (sharpWanted.has(frame) && !(old?.h >= h)) { old?.bm.close(); sharp.set(frame, { bm, h }); onSharp(frame); }
        else bm.close();
      })
      .catch(e => console.warn('decode failed', frame.name, e))
      .finally(() => { sharpRunning--; pumpSharp(); });
  }
}

// Downscaled decode, by default at the export cell height. Chrome applies the JPEG's own EXIF
// orientation; an embedded RAW preview without EXIF still needs turning, which shows as a
// landscape bitmap.
export async function decodeThumb(frame, height = CELL_H) {
  const bm = await createImageBitmap(frameBlob(frame, 'sheet'), { resizeHeight: height, resizeQuality: 'high' });
  return orient(bm, frame.orientation);
}

export function orient(bm, orientation) {
  const quarter = orientation === 6 ? 1 : orientation === 8 ? -1 : 0;
  if (!quarter || bm.height >= bm.width) return bm;
  const c = new OffscreenCanvas(bm.height, bm.width);
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate(quarter * Math.PI / 2);
  g.drawImage(bm, -bm.width / 2, -bm.height / 2);
  bm.close();
  return c.transferToImageBitmap();
}
