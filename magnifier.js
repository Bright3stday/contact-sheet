// Magnifier: a larger view of the frame under the hovering S Pen or mouse, shown on the half
// of the stage away from the pointer so it never covers the frame being looked at.
import { decodeThumb, getBitmap } from './sheet.js';

const WIDTH = 0.46;      // of the stage width

const $ = id => document.getElementById(id);
const box = $('magnifier');
const canvas = $('magnifier-canvas');
const ctx = canvas.getContext('2d');

let frame = null;        // frame shown
let image = null;        // its decode at the magnifier size (owned here)
let token = 0;

// cell: { frame, number }; stage: the stage's client rect; x: pointer clientX
export function showMagnifier(cell, stage, x) {
  const w = Math.round(stage.width * WIDTH), h = Math.round(w * 2 / 3);
  box.style.width = w + 'px';
  box.style.left = (x < stage.left + stage.width / 2 ? stage.right - w - 16 : stage.left + 16) + 'px';
  box.style.top = Math.max(stage.top + 8, stage.top + (stage.height - h) / 2 - 20) + 'px';
  box.hidden = false;
  if (cell.frame === frame) return;

  frame = cell.frame;
  $('magnifier-label').textContent = `${cell.number}  ${frame.name}  ${frame.time.slice(11, 19)}`;
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * devicePixelRatio);
  canvas.height = Math.round(h * devicePixelRatio);
  image?.close();
  image = null;
  draw(getBitmap(frame));   // the sheet thumbnail until the sharper decode arrives

  if (!frame.jpg && !frame.raw) return;
  const t = ++token, f = frame;
  decodeThumb(f, canvas.height)
    .then(bm => {
      if (t !== token) { bm.close(); return; }
      image = bm;
      draw(bm);
    })
    .catch(e => console.warn('magnifier decode failed', f.name, e));
}

export function hideMagnifier() {
  token++;
  frame = null;
  image?.close();
  image = null;
  box.hidden = true;
}

function draw(bm) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!bm) return;
  const s = Math.min(canvas.width / bm.width, canvas.height / bm.height);
  const w = bm.width * s, h = bm.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bm, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}
