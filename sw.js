// Offline: the app's own files are cached at install and always served from the cache.
// Bump VERSION on every deploy so installed copies pick up the new files.
const VERSION = 'contact-sheet-v4';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'scan.js',
  'sheet.js',
  'loupe.js',
  'magnifier.js',
  'marks.js',
  'export.js',
  'manifest.json',
  'vendor/exifr.mjs',
  'vendor/jspdf.umd.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
