#!/usr/bin/env node
/* Acceptance probe for the AU basemap archive.
 *
 * Answers the two questions a re-tile has to answer:
 *
 *   1. Schema parity — does this archive still carry the same layers and
 *      fields the apps style against (core/basemap/layers*.json)? A locally
 *      built archive that gains or loses a layer breaks Nav, Plan, Studio
 *      and the site together.
 *   2. Town coverage — at which zoom does each town first EXIST in a tile?
 *      That is the real gate: places_locality has a non-zero text-size at
 *      every zoom, so the style draws a name the moment the tiler ships it.
 *
 * It also counts localities per tile, because pulling small settlements
 * forward is only worth doing if it does not bury the cities in noise.
 *
 * Usage:
 *   node probe-places.mjs <archive-url-or-path> [more archives…]
 *
 * Two archives are compared side by side, which is how a re-tile is judged:
 *   node probe-places.mjs https://tiles.dingodirt.com/basemap-au.pmtiles ./basemap-au.pmtiles
 */
import { PMTiles, FetchSource } from 'pmtiles';
import zlib from 'node:zlib';
import fs from 'node:fs';

/* ---- a local-file source, so an archive can be probed before upload ---- */
class FileSource {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'r');
  }
  getKey() {
    return this.path;
  }
  async getBytes(offset, length) {
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
}

const openArchive = (spec) =>
  new PMTiles(/^https?:/.test(spec) ? new FetchSource(spec) : new FileSource(spec));

/* ---- minimal MVT reader: layer names, keys, values, feature tags ---- */
function varint(r) {
  let v = 0n, s = 0n, b;
  do {
    b = BigInt(r.buf[r.p++]);
    v |= (b & 0x7fn) << s;
    s += 7n;
  } while (b & 0x80n);
  return Number(v);
}
function skip(r, wt) {
  if (wt === 0) varint(r);
  else if (wt === 1) r.p += 8;
  else if (wt === 2) r.p += varint(r);
  else if (wt === 5) r.p += 4;
}
function sub(r) {
  const l = varint(r);
  const s = { buf: r.buf, p: r.p, end: r.p + l };
  r.p += l;
  return s;
}
function str(r) {
  const l = varint(r);
  const s = r.buf.toString('utf8', r.p, r.p + l);
  r.p += l;
  return s;
}
function readValue(r) {
  let out = null;
  while (r.p < r.end) {
    const k = varint(r), f = k >> 3, wt = k & 7;
    if (f === 1 && wt === 2) out = str(r);
    else if (f === 2 && wt === 5) { out = r.buf.readFloatLE(r.p); r.p += 4; }
    else if (f === 3 && wt === 1) { out = r.buf.readDoubleLE(r.p); r.p += 8; }
    else if (f === 4 || f === 5) out = varint(r);
    else if (f === 6) { const z = varint(r); out = (z >> 1) ^ -(z & 1); }
    else if (f === 7) out = !!varint(r);
    else skip(r, wt);
  }
  return out;
}
function readLayer(r) {
  const keys = [], values = [], features = [];
  let name = null;
  while (r.p < r.end) {
    const k = varint(r), f = k >> 3, wt = k & 7;
    if (f === 1) name = str(r);
    else if (f === 3) keys.push(str(r));
    else if (f === 4) values.push(readValue(sub(r)));
    else if (f === 2) {
      const fr = sub(r), tags = [];
      while (fr.p < fr.end) {
        const fk = varint(fr), ff = fk >> 3, fwt = fk & 7;
        if (ff === 2 && fwt === 2) { const t = sub(fr); while (t.p < t.end) tags.push(varint(t)); }
        else skip(fr, fwt);
      }
      features.push(tags);
    } else skip(r, wt);
  }
  return { name, keys, values, features };
}
function readTile(buf) {
  const r = { buf, p: 0, end: buf.length }, layers = [];
  while (r.p < r.end) {
    const k = varint(r), f = k >> 3, wt = k & 7;
    if (f === 3 && wt === 2) layers.push(readLayer(sub(r)));
    else skip(r, wt);
  }
  return layers;
}

const tileOf = (lon, lat, z) => {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  ];
};

/** Field keys seen on real features, per archive. The metadata inventory is
 *  NOT the schema that matters: the live archive was cut out of the planet
 *  build with `pmtiles extract`, so its places layer advertises fields no
 *  Australian feature has ever carried (name2, script, ref:FR:FANTOIR…).
 *  Measured 2026-09-06: across 60 tiles and 1,341 AU place features, all
 *  eight of the style-referenced multi-script fields were absent. A locally
 *  built AU archive drops them from the inventory too, and the style's
 *  `has` guards take the same branch either way. So parity is judged on the
 *  keys that actually appear. */
const seenKeys = new Map();

function noteKeys(spec, layer) {
  let set = seenKeys.get(spec);
  if (!set) seenKeys.set(spec, (set = new Set()));
  for (const tags of layer.features) {
    for (let i = 0; i < tags.length; i += 2) set.add(layer.keys[tags[i]]);
  }
}

/** Every locality in the tile covering this point, as name → min_zoom. */
async function localitiesAt(archive, lon, lat, z, spec) {
  const [x, y] = tileOf(lon, lat, z);
  const t = await archive.getZxy(z, x, y);
  const out = new Map();
  if (!t) return out;
  let buf = Buffer.from(t.data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  for (const L of readTile(buf)) {
    if (L.name !== 'places') continue;
    if (spec) noteKeys(spec, L);
    for (const tags of L.features) {
      const a = {};
      for (let i = 0; i < tags.length; i += 2) a[L.keys[tags[i]]] = L.values[tags[i + 1]];
      if (a.kind !== 'locality') continue;
      out.set(a.name, { minZoom: a.min_zoom, detail: a.kind_detail, pop: a.population });
    }
  }
  return out;
}

/* Towns chosen to span the range: a capital, a regional centre, two small
 * outback settlements. Blinman (pop ~22) is the one this work is for. */
const TOWNS = [
  ['Port Augusta', 137.77, -32.49, '~13,000'],
  ['Quorn', 138.04, -32.34, '~1,200'],
  ['Hawker', 138.42, -31.89, '~250'],
  ['Blinman', 138.6867, -31.0833, '~22'],
];

/* Clutter check: one dense sample and one sparse one. */
const DENSITY = [
  ['Sydney', 151.21, -33.87],
  ['Flinders', 138.6, -31.5],
];

const ZOOMS = [5, 6, 7, 8, 9, 10, 11, 12];

async function report(spec) {
  const archive = openArchive(spec);
  const header = await archive.getHeader();
  const meta = await archive.getMetadata();
  const layers = (meta.vector_layers ?? []).map((l) => l.id).sort();
  const placeFields = (meta.vector_layers ?? []).find((l) => l.id === 'places');

  console.log(`\n=== ${spec}`);
  console.log(`zooms ${header.minZoom}-${header.maxZoom} · basemap "${meta.version ?? '?'}" · planetiler ${meta['planetiler:version'] ?? '?'}`);
  console.log(`osm data ${meta['planetiler:osm:osmosisreplicationtime'] ?? '?'}`);
  console.log(`layers (${layers.length}): ${layers.join(', ')}`);
  console.log(`places fields: ${Object.keys(placeFields?.fields ?? {}).length}`);

  console.log('\nfirst zoom each town exists in a tile:');
  for (const [name, lon, lat, pop] of TOWNS) {
    let first = null, detail = null;
    for (const z of ZOOMS) {
      const found = (await localitiesAt(archive, lon, lat, z, spec)).get(name);
      if (found) { first = z; detail = found; break; }
    }
    console.log(
      `  ${name.padEnd(13)} pop ${pop.padStart(8)}  ->  ${first ? `z${first}` : 'not before z12'}` +
        (detail ? `  (${detail.detail ?? '?'}, min_zoom ${detail.minZoom})` : ''),
    );
  }

  console.log('\nlocalities per tile (clutter check):');
  for (const [label, lon, lat] of DENSITY) {
    const counts = [];
    for (const z of [6, 7, 8, 9, 10]) {
      counts.push(`z${z}:${(await localitiesAt(archive, lon, lat, z, spec)).size}`);
    }
    console.log(`  ${label.padEnd(10)} ${counts.join('  ')}`);
    // What KIND the z8 places are decides whether the count is towns or noise.
    const kinds = new Map();
    for (const v of (await localitiesAt(archive, lon, lat, 8, spec)).values()) {
      kinds.set(v.detail ?? 'unset', (kinds.get(v.detail ?? 'unset') ?? 0) + 1);
    }
    const parts = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
    console.log(`  ${' '.repeat(10)} z8 by kind: ${parts.join(', ') || 'none'}`);
  }

  return {
    layers,
    metaFieldCount: Object.keys(placeFields?.fields ?? {}).length,
    liveKeys: seenKeys.get(spec) ?? new Set(),
  };
}

const specs = process.argv.slice(2);
if (!specs.length) {
  console.error('usage: node probe-places.mjs <archive-url-or-path> [another…]');
  process.exit(1);
}
const results = [];
for (const s of specs) results.push(await report(s));

if (results.length > 1) {
  console.log('\n=== schema parity');
  const [a, ...rest] = results;
  let ok = true;
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i];
    const added = b.layers.filter((l) => !a.layers.includes(l));
    const lost = a.layers.filter((l) => !b.layers.includes(l));
    // The test that matters: a field some AU feature really carries must
    // not vanish. A metadata-only field is noise from the planet extract.
    const droppedInUse = [...a.liveKeys].filter((k) => !b.liveKeys.has(k)).sort();
    if (added.length || lost.length || droppedInUse.length) ok = false;
    console.log(`  ${specs[i + 1]}`);
    console.log(`    layers added: ${added.length ? added.join(', ') : 'none'}`);
    console.log(`    layers lost:  ${lost.length ? lost.join(', ') : 'none'}`);
    console.log(`    places fields in use: ${a.liveKeys.size} -> ${b.liveKeys.size}`);
    console.log(`    in-use fields dropped: ${droppedInUse.length ? droppedInUse.join(', ') : 'none'}`);
    console.log(`    (metadata inventory ${a.metaFieldCount} -> ${b.metaFieldCount}; a planet extract`);
    console.log(`     advertises fields no AU tile carries, so this alone is not a break)`);
  }
  console.log(ok ? '\n  PARITY OK — safe to publish' : '\n  PARITY BROKEN — do not publish');
  if (!ok) process.exitCode = 1;
}
