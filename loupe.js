// Loupe: one frame large, fit or 100%, pan and pinch, step through the visible sequence.
import { frameBlob } from './scan.js';
import { getBitmap, orient, formatDate } from './sheet.js';
import { marks } from './marks.js';
import { shareFile } from './export.js';

// Touch devices with Web Share (the tablet). Not tied to folder/files mode: Android Chrome
// now has folder access too.
const canShare = navigator.maxTouchPoints > 0 && 'canShare' in navigator;

const $ = id => document.getElementById(id);
const root = $('loupe');
const canvas = $('loupe-canvas');
const ctx = canvas.getContext('2d');

let cells = [];          // visible sequence: { frame, number }
let index = 0;
let onClose = () => {};
let image = null;        // full-res bitmap of the current frame (owned here)
let shown = null;        // what is drawn: full-res, or the sheet thumbnail while loading
let token = 0;

// View: scale = canvas pixels per image pixel; (cx, cy) = image point at the canvas centre.
// fit = true keeps the frame fitted; stepping keeps the zoom and position for comparing bursts.
const view = { fit: true, scale: 1, cx: 0, cy: 0 };

export function openLoupe(sequence, i, closed) {
  cells = sequence;
  onClose = closed;
  view.fit = true;
  root.hidden = false;
  resize();
  go(i);
}

function close() {
  token++;
  image?.close();
  image = shown = null;
  root.hidden = true;
  onClose(cells[index].frame);
}

async function go(i) {
  if (i < 0 || i >= cells.length) return;
  index = i;
  const { frame, number } = cells[i];
  const stars = frame.rating > 0 ? '  ' + '★'.repeat(Math.min(frame.rating, 5)) : '';
  $('loupe-label').textContent = `${number}  ${frame.name}${stars}  ${formatDate(frame.time)} ${frame.time.slice(11, 19)}`;
  $('loupe-prev').disabled = i === 0;
  $('loupe-next').disabled = i === cells.length - 1;
  // tablet: picked frames can go straight to Snapseed or social apps
  const sharable = canShare && marks.picks.has(frame.key);
  $('loupe-share').hidden = !(sharable && frame.jpg);
  $('loupe-share-raw').hidden = !(sharable && frame.raw);

  const old = image;
  image = null;
  // While fitted, the sheet thumbnail stands in until the full image is decoded.
  // While zoomed, show nothing rather than a blurry stand-in for a focus check.
  shown = view.fit ? getBitmap(frame) : null;
  draw();
  old?.close();

  const t = ++token;
  let bm;
  try {
    bm = orient(await createImageBitmap(frameBlob(frame, 'full')), frame.orientation);
  } catch (e) { console.warn('loupe decode failed', frame.name, e); return; }
  if (t !== token) { bm.close(); return; }
  image = shown = bm;
  if (!view.fit && (view.cx > bm.width || view.cy > bm.height)) view.fit = true;
  draw();
}

function fitScale(bm) {
  return Math.min(canvas.width / bm.width, canvas.height / bm.height);
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  $('loupe-zoom').textContent = view.fit ? '100%' : 'Fit';
  if (!shown) return;
  if (view.fit) {
    view.scale = fitScale(shown);
    view.cx = shown.width / 2;
    view.cy = shown.height / 2;
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(view.scale, 0, 0, view.scale,
    canvas.width / 2 - view.cx * view.scale, canvas.height / 2 - view.cy * view.scale);
  ctx.drawImage(shown, 0, 0);
}

// 100% = one image pixel per device pixel, centred on the clicked point.
function zoomTo100(px, py) {
  if (!image) return;
  const s = view.fit ? fitScale(image) : view.scale;
  const ix = view.cx + (px - canvas.width / 2) / s;
  const iy = view.cy + (py - canvas.height / 2) / s;
  view.fit = false;
  view.scale = 1;
  view.cx = ix;
  view.cy = iy;
  draw();
}

function toggleZoom(px = canvas.width / 2, py = canvas.height / 2) {
  if (view.fit) zoomTo100(px, py);
  else { view.fit = true; draw(); }
}

// ---- Input: drag pans, two fingers pinch, double-click/tap toggles fit/100% at that point ----

const pointers = new Map();
let pinch = null;

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * devicePixelRatio, (e.clientY - r.top) * devicePixelRatio];
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, canvasPoint(e));
  if (pointers.size === 2) pinch = pinchState();
});

canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId) || !shown) return;
  const [x, y] = canvasPoint(e);
  const [px, py] = pointers.get(e.pointerId);
  pointers.set(e.pointerId, [x, y]);
  if (!image) return;
  if (pointers.size === 1 && !view.fit) {
    view.cx -= (x - px) / view.scale;
    view.cy -= (y - py) / view.scale;
    draw();
  } else if (pointers.size === 2 && pinch) {
    const now = pinchState();
    const s0 = view.fit ? fitScale(shown) : view.scale;
    const min = fitScale(shown);
    const s = Math.max(min, Math.min(s0 * now.d / pinch.d, 4));
    // keep the image point under the pinch midpoint in place
    const ix = (view.fit ? shown.width / 2 : view.cx) + (pinch.x - canvas.width / 2) / s0;
    const iy = (view.fit ? shown.height / 2 : view.cy) + (pinch.y - canvas.height / 2) / s0;
    view.fit = s <= min;
    view.scale = s;
    view.cx = ix - (now.x - canvas.width / 2) / s;
    view.cy = iy - (now.y - canvas.height / 2) / s;
    pinch = now;
    draw();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function pinchState() {
  const [[x1, y1], [x2, y2]] = [...pointers.values()];
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, d: Math.hypot(x2 - x1, y2 - y1) || 1 };
}

canvas.addEventListener('dblclick', e => toggleZoom(...canvasPoint(e)));

$('loupe-close').addEventListener('click', close);
$('loupe-prev').addEventListener('click', () => go(index - 1));
$('loupe-next').addEventListener('click', () => go(index + 1));
$('loupe-zoom').addEventListener('click', () => toggleZoom());
$('loupe-share').addEventListener('click', () => shareFile(cells[index].frame.jpg));
$('loupe-share-raw').addEventListener('click', () => shareFile(cells[index].frame.raw));

function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * devicePixelRatio);
  canvas.height = Math.round(r.height * devicePixelRatio);
  draw();
}
new ResizeObserver(() => { if (!root.hidden) resize(); }).observe(canvas);
