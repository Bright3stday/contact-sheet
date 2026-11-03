// Magnifier: a round lens that follows the hovering S Pen and shows the sheet under
// the tip larger. It sits just above the tip, so neither the pen nor the hand covers it.
import { decodeThumb } from './sheet.js';

const SIZE = 300;          // lens diameter, CSS px
const GAP = 28;            // between the tip and the lens edge
const SHARP_MAX_H = 1280;

const $ = id => document.getElementById(id);
const lens = $('magnifier');
const canvas = $('magnifier-canvas');
const ctx = canvas.getContext('2d');
lens.style.width = lens.style.height = SIZE + 'px';

// x, y: pen tip in client px. paint(ctx, px) draws the lens content into a px × px canvas,
// with the point under the tip at its centre.
export function showLens(x, y, paint) {
  let left = x - SIZE / 2, top = y - GAP - SIZE;
  if (top < 0) {             // no room above: beside the tip, on the left unless that is off screen too
    top = y - SIZE / 2;
    left = x - GAP - SIZE < 0 ? x + GAP : x - GAP - SIZE;
  }
  lens.style.left = left + 'px';
  lens.style.top = top + 'px';
  const px = Math.round(SIZE * devicePixelRatio);
  if (canvas.width !== px) canvas.width = canvas.height = px;
  lens.hidden = false;
  paint(ctx, px);
}

export function hideLens() {
  lens.hidden = true;
  want = null;
  sharp?.bm.close();
  sharp = null;
}

// A sharper decode of the frame under the lens, at about the height it is shown. Returns the best
// bitmap of that frame so far (or null) and calls ready() when a better one arrives. One decode
// at a time, always for the latest frame asked for, so sweeping the pen across a sheet doesn't
// pile up work.
let sharp = null;   // { frame, h, bm }
let want = null;    // { frame, h, ready }
let busy = false;

export function lensBitmap(frame, height, ready) {
  if (!frame.jpg && !frame.raw) return null;
  const h = Math.min(SHARP_MAX_H, Math.ceil(height / 160) * 160);
  if (sharp?.frame === frame && sharp.h >= h) return sharp.bm;
  if (!want || want.frame !== frame || want.h < h) { want = { frame, h, ready }; pump(); }
  return sharp?.frame === frame ? sharp.bm : null;
}

async function pump() {
  if (busy || !want) return;
  const w = want;
  busy = true;
  try {
    const bm = await decodeThumb(w.frame, w.h);
    if (want === w) {
      sharp?.bm.close();
      sharp = { frame: w.frame, h: w.h, bm };
      want = null;
      w.ready();
    } else bm.close();
  } catch (e) {
    console.warn('magnifier decode failed', w.frame.name, e);
    if (want === w) want = null;
  }
  busy = false;
  pump();
}
