/* Share-sheet + file-open guard for Nav.
 *
 * Nav is served from GitHub Pages, so a share_target that carries FILES (POST
 * multipart — the only kind that can) has no server to answer it. sw.js answers
 * the POST itself. Three things silently break that, and all three look fine in
 * review, so they are asserted here instead:
 *
 *   1. the share_target quietly reverting to GET — files are dropped, and only a
 *      real Android share shows it;
 *   2. the POST branch sliding below sw.js's `method !== 'GET'` bail-out — the
 *      POST then reaches the static host and 405s;
 *   3. the activate sweep deleting the share bucket mid-share.
 *
 * It also pins the ?share= / ?url= text contract, because one manifest gets one
 * share_target: the Google Maps link import shares the action with the files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const NAV = join(REPO, 'apps/nav');
const manifest = JSON.parse(readFileSync(join(NAV, 'manifest.json'), 'utf8'));
const sw = readFileSync(join(NAV, 'sw.js'), 'utf8');
const html = readFileSync(join(NAV, 'index.html'), 'utf8');

test('share_target can carry files at all', () => {
  const st = manifest.share_target;
  assert.ok(st, 'manifest must declare a share_target');
  // GET share targets cannot carry files — this is the whole point of the POST
  assert.equal(st.method.toUpperCase(), 'POST');
  assert.equal(st.enctype, 'multipart/form-data');
  const files = st.params?.files;
  assert.ok(Array.isArray(files) && files.length, 'share_target.params.files missing');
  const accept = files.flatMap(f => f.accept);
  assert.ok(accept.includes('.gpx'), 'share_target must accept .gpx by extension');
  assert.ok(accept.some(a => a === 'application/gpx+xml'),
    'share_target must accept the GPX MIME type — Android matches on it');
});

test('share_target keeps the text/link params the gmaps import reads', () => {
  const p = manifest.share_target.params;
  // index.html reads params.get('share') / params.get('url') after sw.js
  // rebuilds the query string; the field NAMES are what must not drift
  assert.equal(p.text, 'share');
  assert.equal(p.url, 'url');
  for (const field of ['share', 'url']) {
    assert.ok(sw.includes(`form.get('${field}')`),
      `sw.js must read the '${field}' form field back out of the POST`);
    assert.ok(sw.includes(`p.set('${field}'`),
      `sw.js must put '${field}' back on the query string for index.html`);
  }
});

test('a .gpx is offered on the desktop "Open with" list', () => {
  const exts = (manifest.file_handlers || []).flatMap(h => Object.values(h.accept).flat());
  assert.ok(exts.includes('.gpx'), 'file_handlers must accept .gpx');
  assert.ok(exts.includes('.dingonav'), 'the .dingonav handler must survive');
});

test('sw.js answers the share POST before it bails out on non-GET', () => {
  const branch = sw.indexOf("e.request.method === 'POST'");
  const bail = sw.indexOf("e.request.method !== 'GET'");
  assert.ok(branch > -1, 'sw.js has no share POST branch');
  assert.ok(bail > -1, 'sw.js lost its non-GET bail-out');
  assert.ok(branch < bail,
    'the share POST branch must come BEFORE the non-GET bail-out, or the POST 405s');
});

test('sw.js share action matches the manifest action', () => {
  const action = manifest.share_target.action.replace(/^\.\//, '');
  assert.match(sw, new RegExp(`SHARE_ACTION = '${action}'`),
    `sw.js SHARE_ACTION must equal the manifest action (${action})`);
});

test('the share bucket survives the activate sweep', () => {
  assert.match(sw, /k !== CACHE && k !== SHARE/,
    'activate must spare the share cache, or a share in flight is deleted');
});

test('sw.js and index.html agree on the handover', () => {
  // the flag sw.js redirects with, and the cache both sides name
  assert.ok(sw.includes("'?share_files=1'"), 'sw.js must flag a file share');
  assert.ok(html.includes("params.has('share_files')"), 'index.html must read that flag');
  assert.match(sw, /const SHARE = 'dingonav-share'/);
  assert.ok(html.includes("caches.open('dingonav-share')"),
    'index.html must drain the same cache sw.js fills');
  // the shared files must reach the one ingestion path, not a second copy of it
  assert.match(html, /await handleFiles\(f\)/,
    'shared files must go through handleFiles(), like the picker and drag-drop');
});

/* ---------------------------------------------------------------------------
 * Behaviour: run sw.js's share handler for real.
 *
 * The static checks above all passed while the handler was in fact dropping
 * every share on the floor (a relative Request URL threw, and the catch ate
 * it). So load the worker into a mock scope and assert what comes out.
 * ------------------------------------------------------------------------- */

const SW_ORIGIN = 'https://nav.dingodirt.com';

function loadWorker() {
  const store = new Map();
  const bucket = name => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    const key = r => (typeof r === 'string' ? r : r.url);
    return {
      put: async (r, res) => m.set(key(r), res),
      match: async r => m.get(key(r)),
      keys: async () => [...m.keys()].map(u => new Request(u)),
      delete: async r => m.delete(key(r)),
      addAll: async () => {},
    };
  };
  const listeners = {};
  const scope = {
    location: new URL(`${SW_ORIGIN}/sw.js`),
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const caches = {
    open: async n => bucket(n),
    keys: async () => [...store.keys()],
    delete: async n => store.delete(n),
    match: async () => undefined,
  };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'location', sw)(scope, caches, scope.location);
  const share = form => new Promise(resolve => listeners.fetch[0]({
    request: new Request(`${SW_ORIGIN}/share-target`, { method: 'POST', body: form }),
    respondWith: p => resolve(p),
  }));
  return { share, store };
}

test('a shared .gpx is parked for the page and the app is opened', async () => {
  const { share, store } = loadWorker();
  const form = new FormData();
  form.append('files', new File(['<gpx/>'], 'Blue Rag Range.gpx', { type: 'application/gpx+xml' }));
  form.append('files', new File(['PK..'], 'pack.dingonav', { type: 'application/zip' }));

  const res = await share(form);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), `${SW_ORIGIN}/?share_files=1`);

  const parked = store.get('dingonav-share');
  assert.ok(parked, 'nothing was parked for the page to drain');
  const keys = [...parked.keys()].sort();
  assert.equal(keys.length, 2);
  // zero-padded so the page's lexical sort restores the rider's order
  assert.match(keys[0], /\/shared\/000-Blue%20Rag%20Range\.gpx$/);
  assert.match(keys[1], /\/shared\/001-pack\.dingonav$/);
  // and the bytes actually survived the hop
  assert.equal(await parked.get(keys[0]).text(), '<gpx/>');
});

test('a shared Google Maps link still arrives as ?share=', async () => {
  const { share, store } = loadWorker();
  const form = new FormData();
  form.append('share', 'Check this out https://maps.app.goo.gl/abc123');

  const res = await share(form);
  assert.equal(res.status, 303);
  const q = new URL(res.headers.get('Location')).searchParams;
  assert.equal(q.get('share'), 'Check this out https://maps.app.goo.gl/abc123');
  assert.ok(!q.has('share_files'), 'a text share must not claim to carry files');
  assert.ok(!store.has('dingonav-share'), 'a text share must not touch the file bucket');
});

test('a shared bare url still arrives as ?url=', async () => {
  const { share } = loadWorker();
  const form = new FormData();
  form.append('url', 'https://maps.app.goo.gl/xyz');

  const q = new URL((await share(form)).headers.get('Location')).searchParams;
  assert.equal(q.get('url'), 'https://maps.app.goo.gl/xyz');
});

test('an empty share opens the app rather than dead-ending', async () => {
  const { share } = loadWorker();
  const res = await share(new FormData());
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), `${SW_ORIGIN}/`);
});
