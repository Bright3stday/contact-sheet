// App state and UI wiring.
import { filesFromFolder, filesFromInput, scanFrames } from './scan.js';
import { SHEET_W, SHEET_H, PER_SHEET, buildSheets, drawSheet, getBitmap, keepBitmaps } from './sheet.js';
import { openLoupe } from './loupe.js';
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
      baseName: 'contact-' + ((state.frames[0]?.time || '').slice(0, 10).replace(/:/g, '-') || 'sheet'),
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
  if (!state.sheets.length) { state.current = 0; render(); updateBar(); return; }
  state.current = Math.max(0, Math.min(i, state.sheets.length - 1));
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
  if (!sheet) return;
  const s = canvas.width / SHEET_W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  const last = state.current === state.sheets.length - 1;
  const key = (state.ratedOnly ? 'r' : 'a') + state.current;
  drawSheet(ctx, sheet, state.sheets.length, last ? state.trailingSkip : 0, getBitmap,
    { picks: marks.picks, items: sheetItems(key) });
  updateStatus();
}

function fitCanvas() {
  const stage = $('stage');
  const box = stage.getBoundingClientRect();
  const pad = 16;
  const scale = Math.min((box.width - pad) / SHEET_W, (box.height - pad) / SHEET_H);
  const cssW = Math.floor(SHEET_W * scale), cssH = Math.floor(SHEET_H * scale);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * devicePixelRatio);
  canvas.height = Math.round(cssH * devicePixelRatio);
  render();
}

new ResizeObserver(fitCanvas).observe($('stage'));
status(folderMode ? 'Open a shoot folder' : 'Open photos');

// Offline install only from the HTTPS host; the local dev server always serves fresh files.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}
