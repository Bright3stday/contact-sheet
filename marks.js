// Marking on the sheet (picks, pen, box), undo/clear, autosave in IndexedDB, and the marks file.
import { cellAt } from './sheet.js';

// picks: frame keys. items: per sheet layout ("r0" = rated-only sheet 1, "a2" = all-frames
// sheet 3) a list of { type: 'pen', points: [[x, y, pressure]] } or { type: 'box', x, y, w, h }.
export const marks = { picks: new Set(), items: {} };

const undoStacks = {};   // sheet layout key -> [undo functions]
let tool = 'select';
let app;                 // hooks from app.js

const $ = id => document.getElementById(id);

// hooks: canvas, current() -> { key, cells }, render(), openLoupe(cellIndex),
//        session() -> { ratedOnly, frames }, importSession(session),
//        toSheet(clientX, clientY) -> [x, y], sheetPerCss() -> sheet units per CSS px,
//        zoomAt(factor, clientX, clientY), panBy(dxCss, dyCss)
export function initMarks(hooks) {
  app = hooks;
  for (const b of document.querySelectorAll('.tool')) {
    b.addEventListener('click', () => {
      tool = b.dataset.tool;
      for (const o of document.querySelectorAll('.tool')) o.setAttribute('aria-pressed', o === b);
    });
  }
  $('undo').addEventListener('click', undo);
  $('clear').addEventListener('click', clearSheet);
  $('marks-export').addEventListener('click', exportMarks);
  $('marks-import').addEventListener('click', () => $('marks-file').click());
  $('marks-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let session;
    try { session = JSON.parse(await file.text()); } catch { alert('Not a marks file'); return; }
    if (session?.version !== 1 || !Array.isArray(session.frames)) { alert('Not a marks file'); return; }
    app.importSession(session);
  });
  attachInput(app.canvas);
}

export function sheetItems(key) {
  return marks.items[key] || (marks.items[key] = []);
}

function changed() {
  app.render();
  saveSession();
}

function pushUndo(fn) {
  const key = app.current().key;
  (undoStacks[key] || (undoStacks[key] = [])).push(fn);
}

// Undo works per sheet: it only takes back what was done on the sheet in view.
function undo() {
  const cur = app.current();
  const fn = cur && undoStacks[cur.key]?.pop();
  if (fn) { fn(); changed(); }
}

// Clears the drawings (pen and box) on this sheet. Picks are data and stay.
function clearSheet() {
  const cur = app.current();
  if (!cur) return;
  const list = sheetItems(cur.key);
  if (!list.length || !confirm('Clear the drawings on this sheet? Picks stay.')) return;
  const removed = list.splice(0);
  pushUndo(() => list.push(...removed));
  changed();
}

function togglePick(frame) {
  const flip = () => marks.picks.has(frame.key) ? marks.picks.delete(frame.key) : marks.picks.add(frame.key);
  flip();
  pushUndo(flip);
  changed();
}

// ---- Pointer input ----
// Pen and mouse draw with the Pen/Box tool and erase with the Eraser. Fingers never draw:
// they tap (pick) and double-tap (loupe). A tap with the S Pen or mouse also picks, except
// with the Eraser. With the Box tool, dragging a box's edge moves it and a corner resizes it.
// Two fingers pinch-zoom the sheet; a drag that isn't drawing (a finger, or the Select tool)
// pans it while zoomed.

const TAP_MOVE = 10;     // CSS px of movement that turns a tap into a drag
const HIT_PX = 12;       // CSS px reach for grabbing a box edge/corner or erasing
const DOUBLE_MS = 300;
const PALM_MS = 1000;    // ignore touches this long after the S Pen was near the screen
const ERASER_BUTTON = 5; // pen eraser end, if the pen has one
let lastPen = -Infinity;
let active = null;
let pendingTap = null;
const touches = new Map();   // finger pointerId -> [clientX, clientY]
let pinch = null;            // { x, y, d } midpoint and spread of the two fingers

function attachInput(canvas) {
  const toSheet = e => app.toSheet(e.clientX, e.clientY).map(v => round(v));
  const reach = () => HIT_PX * app.sheetPerCss();

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') lastPen = e.timeStamp;
    if (e.pointerType === 'touch' && e.timeStamp - lastPen < PALM_MS) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        // a second finger turns the first finger's tap into a pinch
        canvas.setPointerCapture(e.pointerId);
        if (active?.mode === 'tap') active = null;
        pinch = pinchState();
        return;
      }
      if (touches.size > 2) return;
    }
    if (active || (e.button > 0 && e.button !== ERASER_BUTTON) || !app.current()) return;
    canvas.setPointerCapture(e.pointerId);
    const p = toSheet(e);
    const list = sheetItems(app.current().key);
    let mode = e.pointerType !== 'touch' && tool !== 'select' ? tool : 'tap';
    if (e.button === ERASER_BUTTON) mode = 'eraser';
    active = { id: e.pointerId, mode, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY,
      p0: p, moved: false, item: null, list };

    if (mode === 'pen') {
      active.item = { type: 'pen', points: [[...p, pressure(e)]] };
      list.push(active.item);
    } else if (mode === 'box') {
      const grab = grabBox(list, p, reach());
      if (grab) Object.assign(active, grab, { mode: 'adjust', before: { ...grab.box } });
      else {
        active.item = { type: 'box', x: p[0], y: p[1], w: 0, h: 0 };
        list.push(active.item);
      }
    } else if (mode === 'eraser') {
      active.before = list.slice();
      erase(list, p, reach());
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'pen') lastPen = e.timeStamp;
    if (pinch && touches.has(e.pointerId)) {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      const now = pinchState();
      app.panBy(now.x - pinch.x, now.y - pinch.y);
      app.zoomAt(now.d / pinch.d, now.x, now.y);
      pinch = now;
      return;
    }
    if (!active) { hoverCursor(canvas, e, toSheet(e), reach()); return; }
    if (e.pointerId !== active.id) return;
    if (Math.hypot(e.clientX - active.x0, e.clientY - active.y0) > TAP_MOVE) active.moved = true;
    if (active.mode === 'tap') {
      if (active.moved) app.panBy(e.clientX - active.lx, e.clientY - active.ly);
      active.lx = e.clientX;
      active.ly = e.clientY;
      return;
    }
    const [x, y] = toSheet(e);
    const it = active.item;
    const coalesced = e.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [e];
    if (active.mode === 'eraser') {
      for (const ev of events) erase(active.list, toSheet(ev), reach());
    } else if (active.mode === 'adjust') {
      const b = active.box;
      if (active.anchor) {   // resize: opposite corner stays put
        [b.x, b.y, b.w, b.h] = [active.anchor[0], active.anchor[1], x - active.anchor[0], y - active.anchor[1]];
      } else {               // move
        b.x = x - active.offset[0];
        b.y = y - active.offset[1];
      }
    } else if (it?.type === 'pen') {
      for (const ev of events) it.points.push([...toSheet(ev), pressure(ev)]);
    } else if (it) {
      it.w = x - it.x;
      it.h = y - it.y;
    } else return;
    app.render();
  });

  const endTouch = e => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };

  canvas.addEventListener('pointerup', e => {
    endTouch(e);
    if (!active || e.pointerId !== active.id) return;
    const a = active;
    active = null;
    if (a.mode === 'eraser') {
      if (a.list.length !== a.before.length) {
        pushUndo(() => a.list.splice(0, a.list.length, ...a.before));
        changed();
      }
      return;
    }
    if (a.mode === 'adjust' && a.moved) {
      normalizeBox(a.box);
      pushUndo(() => Object.assign(a.box, a.before));
      changed();
      return;
    }
    if (a.item && a.moved) {
      if (a.item.type === 'box') normalizeBox(a.item);
      pushUndo(() => a.list.splice(a.list.indexOf(a.item), 1));
      changed();
      return;
    }
    if (a.item) a.list.splice(a.list.indexOf(a.item), 1);   // too short to be a mark: it was a tap
    if (a.mode === 'adjust') Object.assign(a.box, a.before);
    if (!a.moved) tap(a.p0);
    app.render();
  });

  canvas.addEventListener('pointercancel', e => {
    endTouch(e);
    if (!active || e.pointerId !== active.id) return;
    const a = active;
    active = null;
    if (a.item) a.list.splice(a.list.indexOf(a.item), 1);
    if (a.mode === 'adjust') Object.assign(a.box, a.before);
    if (a.mode === 'eraser') a.list.splice(0, a.list.length, ...a.before);
    app.render();
  });
}

function pinchState() {
  const [[x1, y1], [x2, y2]] = [...touches.values()];
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, d: Math.hypot(x2 - x1, y2 - y1) || 1 };
}

// The topmost box whose corner (resize) or edge (move) is within reach of p.
function grabBox(list, [x, y], r) {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (b.type !== 'box') continue;
    const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
    const c = corners.findIndex(([cx, cy]) => Math.hypot(x - cx, y - cy) <= r);
    if (c >= 0) return { box: b, anchor: corners[3 - c] };
    if (boxEdgeDistance(b, x, y) <= r) return { box: b, offset: [x - b.x, y - b.y] };
  }
  return null;
}

function boxEdgeDistance(b, x, y) {
  const x1 = b.x + b.w, y1 = b.y + b.h;
  const dx = Math.max(b.x - x, 0, x - x1), dy = Math.max(b.y - y, 0, y - y1);
  if (dx || dy) return Math.hypot(dx, dy);
  return Math.min(x - b.x, x1 - x, y - b.y, y1 - y);
}

// Removes every whole mark the eraser touches at p.
function erase(list, [x, y], r) {
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    const hit = it.type === 'box'
      ? boxEdgeDistance(it, x, y) <= r
      : it.points.some((q, k) => segmentDistance(x, y, it.points[Math.max(k - 1, 0)], q) <= r);
    if (hit) list.splice(i, 1);
  }
}

function segmentDistance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// Mouse cursor hints on the PC: grab handles of boxes with the Box tool.
function hoverCursor(canvas, e, p, r) {
  if (e.pointerType !== 'mouse') return;
  let cursor = tool === 'select' ? '' : 'crosshair';
  if (tool === 'box' && app.current()) {
    const grab = grabBox(sheetItems(app.current().key), p, r);
    if (grab) cursor = grab.anchor ? 'nwse-resize' : 'move';
  }
  canvas.style.cursor = cursor;
}

// Single tap picks after a short wait; a second tap on the same frame opens the loupe instead.
function tap([x, y]) {
  const cur = app.current();
  const i = cellAt(x, y);
  if (i < 0 || i >= cur.cells.length) return;
  if (pendingTap && pendingTap.cell === i) {
    clearTimeout(pendingTap.timer);
    pendingTap = null;
    app.openLoupe(i);
    return;
  }
  if (pendingTap) clearTimeout(pendingTap.timer);
  const frame = cur.cells[i].frame;
  pendingTap = { cell: i, timer: setTimeout(() => { pendingTap = null; togglePick(frame); }, DOUBLE_MS) };
}

function pressure(e) {
  return e.pointerType === 'pen' ? round(e.pressure, 100) : 0.5;
}

function round(v, k = 10) {
  return Math.round(v * k) / k;
}

function normalizeBox(b) {
  if (b.w < 0) { b.x += b.w; b.w = -b.w; }
  if (b.h < 0) { b.y += b.h; b.h = -b.h; }
}

// ---- Session: autosave and the marks file ----

function buildSession() {
  const { ratedOnly, frames } = app.session();
  const items = {};
  for (const [k, list] of Object.entries(marks.items)) if (list.length) items[k] = list;
  return {
    version: 1,
    ratedOnly,
    frames: frames.map(f => ({ name: f.name, key: f.key, rating: f.rating, time: f.time, subsec: f.subsec })),
    picks: [...marks.picks],
    items,
  };
}

// Resolves a saved session against the scanned frames by key. Frames not found stay in the
// list as empty placeholders so the sheet layout (and the strokes on it) still lines up.
export function applySession(session, scanned) {
  const byKey = new Map(scanned.map(f => [f.key, f]));
  const missing = [];
  const frames = session.frames.map(s => {
    const f = byKey.get(s.key);
    if (!f) {
      missing.push(s.name);
      return { ...s, jpg: null, raw: null, orientation: 1, previews: null };
    }
    f.rating = s.rating;   // the session's ratings decide the rated-only layout
    return f;
  });
  marks.picks = new Set(session.picks);
  marks.items = session.items || {};
  for (const k in undoStacks) delete undoStacks[k];
  return { frames, missing };
}

export function resetMarks() {
  marks.picks = new Set();
  marks.items = {};
  for (const k in undoStacks) delete undoStacks[k];
}

function exportMarks() {
  if (!app.session().frames.length) return;
  const session = buildSession();
  const date = (session.frames[0].time || '').slice(0, 10).replace(/:/g, '-') || 'session';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(session)], { type: 'application/json' }));
  a.download = `marks-${date}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const DB_NAME = 'contact-sheet';
const STORE = 'sessions';
let dbPromise = null;

// Kept open so a save starts writing at once (a refresh right after a mark must not lose it).
function db() {
  return dbPromise || (dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => {
      // let go if another tab needs to upgrade or delete the database
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  }));
}

function request(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

// A session is identified by its set of frame keys.
function sessionId(keys) {
  let h = 0x811c9dc5;
  for (const ch of [...keys].sort().join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return `${keys.length}-${(h >>> 0).toString(16)}`;
}

// Called after each finished mark (not during a stroke), so saving every time is cheap enough.
export async function saveSession() {
  if (!app.session().frames.length) return;
  const session = buildSession();
  const keys = session.frames.map(f => f.key);
  try {
    await request('readwrite', s => s.put({ id: sessionId(keys), keys, savedAt: Date.now(), session }));
  } catch (e) { console.warn('autosave failed', e); }
}

// The saved session for exactly these files, or else (after asking) the latest one whose
// frames are all among them — e.g. a tablet session reopened against the full HDD folder.
export async function findSavedSession(scanned) {
  let all;
  try { all = await request('readonly', s => s.getAll()); } catch { return null; }
  const keys = scanned.map(f => f.key);
  const exact = all.find(r => r.id === sessionId(keys));
  if (exact) return exact.session;
  const have = new Set(keys);
  const sub = all.filter(r => r.keys.every(k => have.has(k))).sort((a, b) => b.savedAt - a.savedAt)[0];
  if (sub && confirm(`Restore the saved session with ${sub.keys.length} frames from ${new Date(sub.savedAt).toLocaleString()}?`)) {
    return sub.session;
  }
  return null;
}
