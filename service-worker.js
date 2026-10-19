/*
 * Brückenbauer – service-worker.js
 * ----------------------------------------------------------------------------
 * Makes the game work offline and lets it update itself.
 *
 * Strategy ("stale-while-revalidate" for the whole app):
 *  - install:  every app file is fetched and cached individually (one missing
 *              file does not abort the installation; it is taken from an older
 *              cache if possible).
 *  - fetch:    same-origin GET requests are answered from the cache immediately
 *              (fast start, works offline) while the cache is refreshed in the
 *              background. The app files are refreshed TOGETHER: the new set is
 *              only stored when every file could be downloaded, so the cache never
 *              contains a mix of old and new files. → After an update has been
 *              published, the next start loads it in the background and the start
 *              after that uses it.
 *              Navigations that are not cached fall back to the cached index.html
 *              when offline.
 *  - On localhost / 127.0.0.1 (testing with VS Code "Live Server") the network
 *    is asked first, so changes are visible after a normal reload; the cache is
 *    only used when the server is not reachable.
 *  - activate: deletes only OLD caches of this game ("brueckenbauer-…").
 *
 * The service worker never touches the save game (IndexedDB / localStorage).
 * Bump VERSION whenever the list of files below changes.
 */
'use strict';

const VERSION = '3.4.0';
const CACHE_PREFIX = 'brueckenbauer-';
const CACHE_NAME = CACHE_PREFIX + 'v' + VERSION;

const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'manifest.json',
  'js/audio.js',
  'js/save.js',
  'js/physics.js',
  'js/levels.js',
  'js/levels-b.js',
  'js/levels-c.js',
  'js/levels-d.js',
  'js/time.js',
  'js/levels-time.js',
  'js/weekly.js',
  'js/testlab.js',
  'js/vendor/three.min.js',
  'js/r3d-util.js',
  'js/r3d-models.js',
  'js/r3d-zmodels.js',
  'js/gallery.js',
  'js/r3d-world.js',
  'js/overlay.js',
  'js/render3d.js',
  'js/render.js',
  'js/render-bp.js',
  'js/editor.js',
  'js/main.js',
  'icons/icon-v32-192.png',
  'icons/icon-v32-512.png',
  'icons/icon-v32-maskable-512.png',
  'icons/icon-v32-180.png',
  'icons/favicon-v32-32.png',
  'icons/icon.svg'
];

const DEV_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const DEV = DEV_HOSTS.indexOf(self.location.hostname) >= 0;
const REFRESH_MIN_INTERVAL_MS = 30 * 1000;

// Absolute URLs of the app files (cache keys)
const APP_URLS = PRECACHE.map((p) => new URL(p, self.location.href).href);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Only complete, same-origin, successful responses are ever cached.
function cacheable(res) {
  return !!res && res.ok && res.status === 200 && res.type === 'basic' && !res.redirected;
}

async function fetchFresh(url) {
  // 'no-cache' = always revalidate with the server (bypasses a stale HTTP cache,
  // cheap thanks to ETag / 304)
  const res = await fetch(new Request(url, { cache: 'no-cache', credentials: 'same-origin' }));
  return cacheable(res) ? res : null;
}

async function matchOldCaches(url) {
  const keys = await caches.keys();
  for (const k of keys) {
    if (k === CACHE_NAME || k.indexOf(CACHE_PREFIX) !== 0) continue;
    const c = await caches.open(k);
    const r = await c.match(url);
    if (r) return r;
  }
  return null;
}

async function sameBody(a, b) {
  try {
    const [x, y] = await Promise.all([a.clone().arrayBuffer(), b.clone().arrayBuffer()]);
    if (x.byteLength !== y.byteLength) return false;
    const u = new Uint8Array(x), v = new Uint8Array(y);
    for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function notifyClients(msg) {
  try {
    const list = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    list.forEach((c) => { try { c.postMessage(msg); } catch (e) { /* ignore */ } });
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// install / activate
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_URLS.map(async (url) => {
      try {
        const res = await fetchFresh(url);
        if (res) { await cache.put(url, res); return; }
      } catch (e) { /* offline or missing – try the old cache below */ }
      try {
        const old = await matchOldCaches(url);
        if (old) await cache.put(url, old);
      } catch (e) { /* ignore */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME)
        .map((k) => caches.delete(k)));
    } catch (e) { /* ignore */ }
    await self.clients.claim();
  })());
});

// ---------------------------------------------------------------------------
// background refresh of all app files (atomic: all or nothing)
// ---------------------------------------------------------------------------

let refreshing = null;
let lastRefresh = 0;

function refreshApp() {
  if (refreshing) return refreshing;
  if (Date.now() - lastRefresh < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
  lastRefresh = Date.now();
  refreshing = (async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.all(APP_URLS.map(async (url) => {
      const cached = await cache.match(url);
      let fresh = null;
      try { fresh = await fetchFresh(url); } catch (e) { fresh = null; }
      return { url, cached, fresh };
    }));
    // A file that is cached but could not be fetched now (offline, server
    // error) → keep the complete old set.
    if (results.some((r) => r.cached && !r.fresh)) return;
    let changed = false;
    for (const r of results) {
      if (!r.fresh) continue;
      if (!r.cached || !(await sameBody(r.cached, r.fresh))) changed = true;
    }
    if (!changed) return;
    await Promise.all(results.filter((r) => r.fresh).map((r) => cache.put(r.url, r.fresh)));
    // main.js may listen for this and offer a reload (optional)
    await notifyClients({ type: 'bb-update-ready', version: VERSION });
  })().catch(() => { /* ignore – next start tries again */ }).then(() => { refreshing = null; });
  return refreshing;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

function offlinePage() {
  return new Response(
    '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Brückenbauer</title></head><body style="font-family:sans-serif;text-align:center;padding:3em 1em;background:#8fd3ff;color:#123">' +
    '<h1>Brückenbauer</h1><p>Keine Internetverbindung. Bitte einmal mit Internet öffnen, danach geht das Spiel auch offline.</p></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function cachedAppShell(cache) {
  return (await cache.match(new URL('index.html', self.location.href).href)) ||
         (await cache.match(new URL('./', self.location.href).href)) ||
         null;
}

// Keeps the worker alive for background work (allowed while respondWith() is
// still pending); never lets a failure here break the actual response.
function keepAlive(event, promise) {
  const p = Promise.resolve(promise).catch(() => {});
  try { event.waitUntil(p); } catch (e) { /* event already finished – work continues anyway */ }
}

async function handleNavigate(event) {
  const req = event.request;
  const cache = await caches.open(CACHE_NAME);
  if (!DEV) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      keepAlive(event, refreshApp());
      return cached;
    }
  }
  try {
    const res = await fetch(req);
    if (DEV && cacheable(res) && (await cache.match(req, { ignoreSearch: true }))) {
      keepAlive(event, cache.put(req, res.clone()));
    }
    if (!DEV) keepAlive(event, refreshApp());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cachedAppShell(cache)) || offlinePage();
  }
}

async function handleAsset(event) {
  const req = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: !DEV });
  const isAppFile = APP_URLS.indexOf(req.url.split('#')[0].split('?')[0]) >= 0;

  if (DEV || !cached) {
    try {
      const res = await fetch(req);
      // keep the offline copy up to date
      if (cacheable(res)) keepAlive(event, cache.put(req, res.clone()));
      return res;
    } catch (e) {
      if (cached) return cached;
      throw e;
    }
  }

  // Production, cached: answer from the cache, refresh in the background.
  if (isAppFile) {
    keepAlive(event, refreshApp());
  } else {
    keepAlive(event, fetch(req).then((res) => (cacheable(res) ? cache.put(req, res) : undefined)));
  }
  return cached;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;                       // let the browser handle it
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return; // Chrome DevTools quirk
  if (req.headers.has('range')) return;                                    // media range requests
  if (url.pathname.endsWith('/service-worker.js')) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(event));
  } else {
    event.respondWith(handleAsset(event).catch(() => fetch(req)));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting' || (event.data && event.data.type === 'skipWaiting')) self.skipWaiting();
});
