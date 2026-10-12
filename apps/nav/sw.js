// DingoNav service worker — cache-first so the app works fully offline.
// Bump CACHE when shipping a new version.
const CACHE = 'dingonav-v73';
// Files handed over by the share sheet park here between the share_target POST
// below and the page draining them. A separate bucket on purpose: it must NOT
// be swept with the stale app caches on activate, and it must never be matched
// as app shell (hence the explicit cacheName on the lookups further down).
const SHARE = 'dingonav-share';
const SHARE_ACTION = 'share-target'; // must match manifest.json share_target.action
const SHELL = [
  './', './index.html', './manifest.json', './icon-192.png', './icon-512.png',
  './vendor/maplibre-gl.js', './vendor/maplibre-gl.css', './vendor/pmtiles.js', './vendor/fflate.js',
  './corridor.js', './tracklock.js', './gmaps-link.js',
  // canonical appliers (core/appliers via the ./appliers symlink) — the map
  // cannot style itself offline without them
  './appliers/applier-nav.js', './appliers/scheme.js', './appliers/detail.js',
  // shared chrome tokens + type (core/ui via the ./core-ui symlink)
  './core-ui/tokens.css', './core-ui/fonts.css', './core-ui/chrome.css',
  './core-ui/fonts/barlow-400.woff2', './core-ui/fonts/barlow-500.woff2',
  './basemap/layers.json', './basemap/layers-light.json',
  './basemap/sprites/dark.json', './basemap/sprites/dark.png',
  './basemap/sprites/dark@2x.json', './basemap/sprites/dark@2x.png',
  './basemap/sprites/light.json', './basemap/sprites/light.png',
  './basemap/sprites/light@2x.json', './basemap/sprites/light@2x.png',
];
// ride schemas — Studio's look (.dingoscheme) + feel (.dingobehavior) presets, offline-first
for (const f of ['default', 'classic', 'google-maps', 'waze', 'locus', 'oziexplorer', 'dmd2', 'index'])
  SHELL.push(`./schemes/${f}.json`);
for (const f of ['default', 'google-maps', 'waze', 'locus', 'dmd2', 'index'])
  SHELL.push(`./behaviors/${f}.json`);
const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const RANGES = ['0-255', '256-511', '512-767'];
for (const f of FONTS) for (const r of RANGES) SHELL.push(`./basemap/fonts/${encodeURIComponent(f)}/${r}.pbf`);

// the page asks which version is serving it — for the old → new update banner
self.addEventListener('message', e => {
  if (e.data === 'version' && e.ports[0]) e.ports[0].postMessage(CACHE);
});
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const path = new URL(e.request.url).pathname;
  // Android share sheet -> DingoNav. A share_target that accepts FILES has to be
  // POST/multipart, and Nav is served from GitHub Pages, so there is no server to
  // answer that POST. The SW answers it itself. This MUST stay above the non-GET
  // bail-out below, or the POST reaches the static host and the share is lost.
  if (e.request.method === 'POST' && path.endsWith('/' + SHARE_ACTION)) {
    e.respondWith(takeShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  // the .pmtiles basemap is stored in IndexedDB by the app, not the SW cache
  if (e.request.url.endsWith('.pmtiles')) return;
  const isShellEntry = e.request.mode === 'navigate' || path.endsWith('/index.html') || path.endsWith('/sw.js');
  if (isShellEntry) {
    // network-first: pick up new app versions when online, cached shell when offline
    e.respondWith(fetch(e.request).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return resp;
    }).catch(() => caches.match(e.request, { ignoreSearch: true, cacheName: CACHE }).then(hit => hit || caches.match('./index.html', { cacheName: CACHE }))));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true, cacheName: CACHE }).then(hit => hit || fetch(e.request).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return resp;
    }).catch(() => hit))
  );
});

/* Answer the share_target POST. Two kinds of share arrive on the one action,
   because a manifest gets exactly one share_target:

   - FILES (a .gpx off a mate's message, a .dingonav out of Files) are parked in
     the SHARE cache and the page is told with ?share_files=1. They cannot ride
     on the query string, and a static host cannot take the POST.
   - TEXT / a LINK keeps the older ?share= / ?url= contract untouched, so the
     Google Maps link import in index.html carries on working exactly as it did
     when this share_target was still a GET.

   Whatever happens, redirect into the app: a share that lands on a 404 looks
   like DingoNav crashed. 303 so the browser follows it as a GET. */
async function takeShare(req) {
  let q = '';
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter(f => f && f.name);
    if (files.length) {
      const c = await caches.open(SHARE);
      // zero-padded index: cache.keys() order is unspecified, and a multi-select
      // share should reach handleFiles in the order the rider picked
      // absolute key: a relative Request URL is resolved against the worker's
      // own location, which is fine in a browser but needless rope — spell it out
      await Promise.all(files.map((f, i) => c.put(
        new URL('./shared/' + String(i).padStart(3, '0') + '-' + encodeURIComponent(f.name),
          self.location).href,
        new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))));
      q = '?share_files=1';
    } else {
      const p = new URLSearchParams();
      const text = form.get('share') || form.get('title');
      const url = form.get('url');
      if (text) p.set('share', text);
      if (url) p.set('url', url);
      if (p.toString()) q = '?' + p;
    }
  } catch (err) {
    // an unparseable share still opens the app, rather than a dead end — but say
    // so: a silent catch here once hid the share never arriving at all
    console.warn('[dingonav] share failed', err);
  }
  return Response.redirect(new URL('./' + q, self.location).href, 303);
}
