#!/usr/bin/env node
// dev-tile-server.js — stand in for tiles.dingodirt.com until the R2 archive
// is live (or when working offline). Serves local .pmtiles archives under the
// shared-archive names with the byte-range + CORS support the pmtiles
// protocol needs. Point any app at it with:
//
//     localStorage.setItem('dtiles-base', 'http://localhost:8787/')
//
// (same override key in Nav and Plan; remove the key to go back to the real
// archive). Defaults to the central-coast dev tiles committed in Nav.
//
// Usage: node tools/dev-tile-server.js [port] [basemap.pmtiles] [hillshade.pmtiles]
const http = require('http');
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const port = parseInt(process.argv[2] || '8787', 10);
const FILES = {
  '/basemap-au.pmtiles': process.argv[3] || path.join(repo, 'apps/nav/basemap/central-coast.pmtiles'),
  '/hillshade-au.pmtiles': process.argv[4] || path.join(repo, 'apps/nav/basemap/hillshade.pmtiles'),
};

http.createServer((req, res) => {
  const file = FILES[req.url.split('?')[0]];
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (!file || !fs.existsSync(file)) { res.writeHead(404, cors); return res.end('not found'); }
  const size = fs.statSync(file).size;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = +range[1];
    const end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.writeHead(206, { ...cors, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...cors, 'Accept-Ranges': 'bytes', 'Content-Length': size,
      'Content-Type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }
}).listen(port, () => {
  console.log(`dev tile archive on http://localhost:${port}/`);
  for (const [name, f] of Object.entries(FILES)) console.log(`  ${name} -> ${f}`);
});
