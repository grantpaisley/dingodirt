// Static server for the perf harness. One process serves the repo root (Nav
// and Studio resolve their core/ symlinks on disk), the Plan dist with an SPA
// fallback, the shared tile archive under /tiles/ with byte-range support,
// and a handful of path overrides (Nav's gitignored bundle.json lives in the
// harness cache, not in the app tree). CORS is open: the pmtiles protocol and
// Plan's dev origin both need it.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.gpx': 'application/gpx+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.pbf': 'application/x-protobuf',
  '.pmtiles': 'application/octet-stream', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

/**
 * @param {object} opts
 * @param {string} opts.root        directory served at /
 * @param {Record<string,string>} [opts.overrides]  url path → file path
 * @param {Record<string,string>} [opts.mounts]     url prefix → directory (SPA fallback to index.html)
 */
export function startServer({ root, overrides = {}, mounts = {} }) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    let file = overrides[url];
    if (!file) {
      const mount = Object.keys(mounts).find((p) => url === p || url.startsWith(p + '/'));
      if (mount) {
        const rel = normalize(url.slice(mount.length) || '/');
        file = join(mounts[mount], rel);
        if (!existsSync(file) || statSync(file).isDirectory()) {
          const idx = join(file, 'index.html');
          file = existsSync(idx) ? idx : join(mounts[mount], 'index.html');
        }
      } else {
        file = join(root, normalize(url));
        if (!resolve(file).startsWith(resolve(root))) { res.writeHead(403, cors); return res.end(); }
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      }
    }
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, cors); return res.end('not found'); }

    const size = statSync(file).size;
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = +range[1];
      const end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
      res.writeHead(206, { ...cors, 'Accept-Ranges': 'bytes', 'Content-Type': type,
        'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...cors, 'Accept-Ranges': 'bytes', 'Content-Type': type, 'Content-Length': size });
      createReadStream(file).pipe(res);
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}
