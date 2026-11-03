// App state and UI wiring.
import { filesFromFolder, filesFromInput, scanFrames } from './scan.js';
import { SHEET_W, SHEET_H, PER_SHEET, buildSheets, cellAt, cellRect, drawSheet, getBitmap, keepBitmaps, keepSharp } from './sheet.js';
import { openLoupe } from './loupe.js';
import { showLens, hideLens, lensBitmap } from './magnifier.js';
import { marks, initMarks, sheetItems, applySession, resetMarks, findSavedSession, saveSession } from './marks.js';
import { exportAll } from './export.js';

const folderMode = 'showDirectoryPicker' in window;

const state = {
  scanned: [],      // frames found in the opened folder/files, sorted
  frames: [],       // the session's frames: scanned, or the list from a restored/imported session
  ratedOnly: false,
  sheets: [],
  trailingSkip: 0,  // hidden frames after the last visible one
  current: 0,
  dir: null,        // folder mode: the opened shoot folder (exports go into its Picks subfolder)
};

const $ = id => document.getElementById(id);
const canvas = $('sheet');
const ctx = canvas.getContext('2d');

$('open').addEventListener('click', async () => {
  if (!folderMode) { $('files').click(); return; }
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  state.dir = dir;
  load(await filesFromFolder(dir));
});

$('files').addEventListener('change', e => {
  load(filesFromInput(e.target.files));
  e.target.value = '';
});

$('filter').addEventListener('click', () => {
  const first = state.sheets[state.current]?.cells[0]?.number || 1;
  state.ratedOnly = !state.ratedOnly;
  rebuild();
  // stay near the same place in the sequence
  const i = state.sheets.findIndex(s => s.cells[s.cells.length - 1].number >= first);
  show(i < 0 ? state.sheets.length - 1 : i);
  saveSession();
});

$('prev').addEventListener('click', () => show(state.current - 1));
$('next').addEventListener('click', () => show(state.current + 1));

// Exports the layout in view (Rated only or All frames), and the other one too when it has
// drawings. An empty layout (e.g. rated-only for an X-T2 card) is never exported.
$('export').addEventListener('click', async () => {
  if (!state.sheets.length) return;
  const button = $('export');
  button.disabled = true;
  try {
    const layouts = [state.ratedOnly, !state.ratedOnly].map(ratedOnly => {
      const prefix = ratedOnly ? 'r' : 'a';
      const { sheets, trailingSkip } = layout(ratedOnly);
      return {
        name: ratedOnly ? 'rated' : 'all',
        sheets: sheets.map((sheet, i) => ({
          sheet,
          trailingSkip: i === sheets.length - 1 ? trailingSkip : 0,
          marks: { picks: marks.picks, items: sheetItems(prefix + i) },
        })),
      };
    }).filter((l, i) => l.sheets.length && (i === 0 || l.sheets.some(s => s.marks.items.length)));
    const summary = await exportAll({
      layouts,
      picks: state.frames.filter(f => marks.picks.has(f.key)),
      folder: folderMode ? state.dir : null,
      // shoot date + export time, so each export sits beside the earlier ones in time order
      baseName: 'contact-' + ((state.frames[0]?.time || '').slice(0, 10).replace(/:/g, '-') || 'sheet') + '_exported-' + exportStamp(),
      progress: (text, fraction) => {
        if (text) status(text);
        $('progress').hidden = fraction == null;
        if (fraction != null) $('progress').value = fraction;
      },
    });
    alert(summary);
  } catch (e) {
    alert('Export failed: ' + e.message);
  } finally {
    button.disabled = false;
    $('progress').hidden = true;
    updateStatus();
  }
});

// Local time as 2026-11-03-154210: sorts by name, safe in filenames.
function exportStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

initMarks({
  canvas,
  current: () => {
    const sheet = state.sheets[state.current];
    return sheet && { key: (state.ratedOnly ? 'r' : 'a') + state.current, cells: sheet.cells };
  },
  render: scheduleRender,
  openLoupe: i => {
    // double-tap / double-click on a frame
    const sequence = state.sheets.flatMap(s => s.cells);
    openLoupe(sequence, state.current * PER_SHEET + i, frame => {
      // back to the sheet holding the frame the loupe ended on
      show(Math.floor(sequence.findIndex(c => c.frame === frame) / PER_SHEET));
    });
  },
  session: () => ({ ratedOnly: state.ratedOnly, frames: state.frames }),
  toSheet,
  sheetPerCss: () => canvas.width / canvas.getBoundingClientRect().width / viewScale(),
  zoomAt,
  panBy,
  importSession: session => {
    if (!state.scanned.length) { alert('Open the folder or files first, then import the marks file.'); return; }
    const missing = useSession(session);
    saveSession();
    alert(`Imported ${session.frames.length} frames.` +
      (missing.length ? `\n${missing.length} not found:\n${missing.join('\n')}` : ''));
  },
});

async function load(groups) {
  if (!groups.length) { status('No JPEG or RAW files found'); return; }
  status(`Scanning 0 / ${groups.length}`);
  state.scanned = await scanFrames(groups, (done, total) => status(`Scanning ${done} / ${total}`));
  const saved = await findSavedSession(state.scanned);
  if (saved) {
    useSession(saved);
    return;
  }
  resetMarks();
  state.frames = state.scanned;
  state.ratedOnly = state.frames.some(f => f.rating >= 1);
  rebuild();
  show(0);
}

// Takes over a saved or imported session's frame list, filter, picks and drawings.
function useSession(session) {
  const { frames, missing } = applySession(session, state.scanned);
  state.frames = frames;
  state.ratedOnly = session.ratedOnly;
  rebuild();
  show(0);
  return missing;
}

function rebuild() {
  Object.assign(state, layout(state.ratedOnly));
}

// The sheets for one filter choice: { sheets, trailingSkip }.
function layout(ratedOnly) {
  const visible = [];
  let skipped = 0;
  state.frames.forEach((frame, i) => {
    if (ratedOnly && frame.rating < 1) { skipped++; return; }
    visible.push({ frame, number: i + 1, skippedBefore: skipped });
    skipped = 0;
  });
  return { sheets: buildSheets(visible), trailingSkip: skipped };
}

function show(i) {
  unhover();
  if (!state.sheets.length) { state.current = 0; render(); updateBar(); return; }
  const next = Math.max(0, Math.min(i, state.sheets.length - 1));
  if (next !== state.current) view.zoom = 1;   // a new sheet starts fitted
  state.current = next;
  viewChanged();
  const near = [state.current, state.current + 1, state.current - 1]
    .filter(n => n >= 0 && n < state.sheets.length)
    .flatMap(n => state.sheets[n].cells.map(c => c.frame));
  keepBitmaps(near, frame => {
    if (state.sheets[state.current].cells.some(c => c.frame === frame)) scheduleRender();
  });
  render();
  updateBar();
}

function updateBar() {
  const n = state.sheets.length;
  $('page').textContent = n ? `${state.current + 1} / ${n}` : '–';
  $('prev').disabled = state.current <= 0;
  $('next').disabled = state.current >= n - 1;
  $('filter').disabled = !state.frames.length;
  $('filter').textContent = state.ratedOnly ? 'Rated only' : 'All frames';
  updateStatus();
}

function updateStatus() {
  if (!state.frames.length) return;
  const rated = state.frames.filter(f => f.rating >= 1).length;
  status(`${state.frames.length} frames · ${rated} rated · ${marks.picks.size} picks`);
}

function status(text) { $('status').textContent = text; }

// ---- Canvas sizing and drawing ----

let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

function render() {
  const sheet = state.sheets[state.current];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!sheet || !canvas.width || !canvas.height) return;   // not laid out yet
  const s = viewScale();
  ctx.setTransform(s, 0, 0, s, canvas.width / 2 - view.cx * s, canvas.height / 2 - view.cy * s);
  paintSheet(ctx, getBitmap);
  updateStatus();
}

// The current sheet with its marks, through whatever transform ctx has (screen or lens).
function paintSheet(ctx, bitmaps) {
  const sheet = state.sheets[state.current];
  const last = state.current === state.sheets.length - 1;
  const key = (state.ratedOnly ? 'r' : 'a') + state.current;
  drawSheet(ctx, sheet, state.sheets.length, last ? state.trailingSkip : 0, bitmaps,
    { picks: marks.picks, items: sheetItems(key) });
}

// The canvas fills the stage; the sheet is drawn into it through the view.
function fitCanvas() {
  const box = canvas.getBoundingClientRect();
  canvas.width = Math.round(box.width * devicePixelRatio);
  canvas.height = Math.round(box.height * devicePixelRatio);
  viewChanged();
  render();
}

new ResizeObserver(fitCanvas).observe($('stage'));

// ---- Sheet view: zoom 1 = whole sheet fitted; (cx, cy) = sheet point at the canvas centre ----

const MAX_ZOOM = 4;
const view = { zoom: 1, cx: SHEET_W / 2, cy: SHEET_H / 2 };

// canvas pixels per sheet unit
function viewScale() {
  return Math.min(canvas.width / SHEET_W, canvas.height / SHEET_H) * view.zoom;
}

function toSheet(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const s = viewScale();
  return [
    view.cx + ((clientX - r.left) * canvas.width / r.width - canvas.width / 2) / s,
    view.cy + ((clientY - r.top) * canvas.height / r.height - canvas.height / 2) / s,
  ];
}

// Zooms by factor, keeping the sheet point under (clientX, clientY) in place.
function zoomAt(factor, clientX, clientY) {
  const [x, y] = toSheet(clientX, clientY);
  view.zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom * factor));
  const [x2, y2] = toSheet(clientX, clientY);
  view.cx += x - x2;
  view.cy += y - y2;
  viewChanged();
}

function panBy(dxCss, dyCss) {
  const k = viewScale() * canvas.getBoundingClientRect().width / canvas.width;   // CSS px per sheet unit
  view.cx -= dxCss / k;
  view.cy -= dyCss / k;
  viewChanged();
}

function viewChanged() {
  // keep the sheet filling the view; centre it along an axis where it fits
  const s = viewScale();
  for (const [k, size, span] of [['cx', SHEET_W, canvas.width / s], ['cy', SHEET_H, canvas.height / s]]) {
    view[k] = span >= size ? size / 2 : Math.max(span / 2, Math.min(size - span / 2, view[k]));
  }
  $('fit').disabled = view.zoom === 1;
  scheduleRender();
  scheduleSharp();
}

// After zooming settles, the frames in view get decoded at the size they are shown.
let sharpTimer = 0;
function scheduleSharp() {
  clearTimeout(sharpTimer);
  sharpTimer = setTimeout(() => {
    const sheet = state.sheets[state.current];
    const s = viewScale();
    const left = view.cx - canvas.width / 2 / s, right = view.cx + canvas.width / 2 / s;
    const top = view.cy - canvas.height / 2 / s, bottom = view.cy + canvas.height / 2 / s;
    const frames = (sheet?.cells || []).filter((c, i) => {
      const r = cellRect(i);
      return r.x < right && r.x + r.w > left && r.y < bottom && r.y + r.h > top;
    }).map(c => c.frame);
    keepSharp(frames, s, frame => {
      if (state.sheets[state.current]?.cells.some(c => c.frame === frame)) scheduleRender();
    });
  }, 250);
}

$('fit').addEventListener('click', () => { view.zoom = 1; viewChanged(); });

// PC: the wheel (or a trackpad pinch) zooms at the pointer.
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  unhover();
  zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
}, { passive: false });

// ---- Magnifier: a lens that follows the hovering S Pen (or mouse) ----

// It opens when the pen rests over a frame for a moment (a pen on its way to tap or draw keeps
// moving), then follows the pen until it touches down or is lifted out of range.
const HOVER_MS = 500;
const STILL_PX = 8;
const LENS_ZOOM = 2.5;   // relative to the sheet as shown
let magnifierOn = true;
try { magnifierOn = localStorage.getItem('magnifier') !== 'off'; } catch {}
let hoverAt = null;   // where the pen came to rest, in client px
let hoverTimer = 0;
let lensAt = null;    // pen position while the lens is open
let lensPending = false;
let quietCell = -1;   // the frame just tapped or drawn on stays quiet until the pen leaves it

const cellUnder = (x, y) => state.sheets[state.current] ? cellAt(...toSheet(x, y)) : -1;

canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') return;
  if (e.buttons || !magnifierOn) { unhover(); return; }
  if (lensAt) { lensAt = { x: e.clientX, y: e.clientY }; scheduleLens(); return; }
  if (hoverAt && Math.hypot(e.clientX - hoverAt.x, e.clientY - hoverAt.y) <= STILL_PX) return;
  clearTimeout(hoverTimer);
  const at = hoverAt = { x: e.clientX, y: e.clientY };
  const i = cellUnder(at.x, at.y);
  if (i !== quietCell) quietCell = -1;
  else return;
  if (!state.sheets[state.current]?.cells[i]) return;
  hoverTimer = setTimeout(() => { lensAt = at; scheduleLens(); }, HOVER_MS);
});
canvas.addEventListener('pointerdown', e => { unhover(); quietCell = cellUnder(e.clientX, e.clientY); });
canvas.addEventListener('pointerleave', () => { unhover(); quietCell = -1; });

function scheduleLens() {
  if (lensPending) return;
  lensPending = true;
  requestAnimationFrame(() => { lensPending = false; paintLens(); });
}

function paintLens() {
  if (!lensAt || !state.sheets[state.current]) return;
  const { x, y } = lensAt;
  showLens(x, y, (lctx, px) => {
    const [sx, sy] = toSheet(x, y);
    const s = viewScale() * LENS_ZOOM;
    const under = state.sheets[state.current].cells[cellAt(sx, sy)]?.frame;
    const sharp = under && lensBitmap(under, cellRect(0).h * s, scheduleLens);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, px, px);
    lctx.setTransform(s, 0, 0, s, px / 2 - sx * s, px / 2 - sy * s);
    paintSheet(lctx, f => (f === under && sharp) || getBitmap(f));
  });
}

function unhover() {
  clearTimeout(hoverTimer);
  hoverAt = lensAt = null;
  hideLens();
}

function setMagnifier(on) {
  magnifierOn = on;
  $('magnify').setAttribute('aria-pressed', on);
  if (!on) unhover();
  try { localStorage.setItem('magnifier', on ? 'on' : 'off'); } catch {}
}
$('magnify').addEventListener('click', () => setMagnifier(!magnifierOn));
setMagnifier(magnifierOn);

// ---- Compact toolbar: keeps only drawing tools and paging, for a bigger sheet ----

function setCompact(on) {
  document.body.classList.toggle('compact', on);
  $('compact').textContent = on ? '▾' : '▴';
  $('compact').title = on ? 'Show all buttons' : 'Fewer buttons';
  try { localStorage.setItem('compact', on ? 'on' : 'off'); } catch {}
}
$('compact').addEventListener('click', () => setCompact(!document.body.classList.contains('compact')));
try { setCompact(localStorage.getItem('compact') === 'on'); } catch { setCompact(false); }

// ---- Help: opens by itself on the first visit ----

$('help-open').addEventListener('click', () => $('help').showModal());
$('help-close').addEventListener('click', () => $('help').close());
try {
  if (!localStorage.getItem('helpSeen')) {
    $('help').showModal();
    localStorage.setItem('helpSeen', '1');
  }
} catch {}

status(folderMode ? 'Open a shoot folder' : 'Open photos');

// Offline install only from the HTTPS host; the local dev server always serves fresh files.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}
