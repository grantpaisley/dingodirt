/* Schema + applier contract tests (design 2026-08-02, Testing §):
   - unknown tokens ignored (but carried), missing tokens defaulted
   - malformed / major-version-mismatch rejected
   - applier contract: fixture scheme → pinned override table
   Run: node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScheme, newScheme, resolveScheme, tok, SCHEMA_VERSION, TOKEN_DEFS } from '../js/scheme.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyScheme, basePaintOverrides, applyBaseOverrides } from '../js/applier-nav.js';

test('newScheme carries defaults for every non-inherit token', () => {
  const s = newScheme('X', 'Y');
  for (const [k, def] of Object.entries(TOKEN_DEFS))
    if (def.def != null) assert.equal(s.tokens[k], def.def, k);
});

test('missing tokens default through tok()', () => {
  const s = { schemaVersion: SCHEMA_VERSION, tokens: {} };
  assert.equal(tok(s, 'overlays.route'), '#4AA8FF');
  assert.equal(tok(s, 'basemap.background'), null); // inherit-base
});

test('unknown tokens are kept but flagged, bad values dropped', () => {
  const s = validateScheme({ schemaVersion: '1.0', name: 'T', tokens: {
    'future.thing': 42, 'overlays.route': 'not-a-colour', 'overlays.routeWIn': 99,
    'overlays.heatOpacity': 0.5, 'basemap.base': 'neon' } });
  assert.deepEqual(s.unknown, ['future.thing']);
  assert.equal(s.tokens['future.thing'], 42);              // round-trips for newer apps
  assert.equal(s.tokens['overlays.route'], undefined);     // bad colour dropped
  assert.equal(s.tokens['overlays.routeWIn'], 24);         // clamped to max
  assert.equal(s.tokens['overlays.heatOpacity'], 0.5);
  assert.equal(s.tokens['basemap.base'], undefined);       // bad select dropped
});

test('major version mismatch rejected with a plain message', () => {
  assert.throws(() => validateScheme({ schemaVersion: '2.0', tokens: {} }), /schema v2/);
  assert.throws(() => validateScheme({ tokens: {} }), /schemaVersion/);
  assert.throws(() => validateScheme('nope'), /bad JSON/);
});

test('applier contract: fixture scheme → pinned overrides', () => {
  const s = newScheme('Fixture', '');
  s.tokens['basemap.water'] = '#123456';
  s.tokens['basemap.roadTrack'] = '#654321';
  s.tokens['basemap.trackDashed'] = true;
  s.tokens['basemap.labelText'] = '#ffffff';
  const ov = basePaintOverrides(s);
  assert.deepEqual(ov.water, { 'fill-color': '#123456' });
  assert.deepEqual(ov.roads_other, { 'line-color': '#654321', 'line-dasharray': [2.5, 1.6] });
  assert.deepEqual(ov.__labels, { 'text-color': '#ffffff' });

  const base = [
    { id: 'water', type: 'fill', paint: { 'fill-color': '#000' } },
    { id: 'roads_major', type: 'line', paint: { 'line-color': '#111' } },
    { id: 'places_locality', type: 'symbol', paint: { 'text-color': '#222', 'text-halo-color': '#333' } },
  ];
  const out = applyBaseOverrides(base, ov);
  assert.equal(out[0].paint['fill-color'], '#123456');       // overridden
  assert.equal(out[1].paint['line-color'], '#111');          // untouched → base value survives
  assert.equal(out[2].paint['text-color'], '#ffffff');       // label sentinel hits every symbol layer
  assert.equal(out[2].paint['text-halo-color'], '#333');     // halo not set → inherited
  assert.equal(base[0].paint['fill-color'], '#000');         // pure — input untouched

  const full = applyScheme(s);
  assert.equal(full.adv.colRoute, '#4AA8FF');
  assert.equal(full.css['--warn'], '#ffb020');
  assert.equal(full.marks.danger, '#f0c24b');
  assert.equal(full.hill['hillshade-exaggeration'], 0.8); // registry default since the light-terrain look (2026-08-15)
});

test('night overlay resolves over day, day untouched', () => {
  const s = newScheme('N', '');
  s.tokens['overlays.route'] = '#111111';
  s.night = { 'overlays.route': '#222222', 'basemap.base': 'dark' };
  assert.equal(resolveScheme(s, 'day').tokens['overlays.route'], '#111111');
  assert.equal(resolveScheme(s, 'night').tokens['overlays.route'], '#222222');
  assert.equal(resolveScheme(s, 'night').tokens['basemap.base'], 'dark');
  assert.equal(resolveScheme(s).tokens['overlays.route'], '#111111'); // default = day
});

test('validateScheme cleans the night overlay too', () => {
  const s = validateScheme({ schemaVersion: '1.0', tokens: {},
    night: { 'overlays.route': 'bad', 'hud.bg': '#000000', 'future.x': 1 } });
  assert.equal(s.night['overlays.route'], undefined);
  assert.equal(s.night['hud.bg'], '#000000');
  assert.equal(s.night['future.x'], 1);
  assert.ok(s.unknown.includes('future.x'));
});

test('every bundled scheme validates and resolves both modes', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemes');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  assert.ok(index.length >= 6);
  for (const entry of index) {
    const raw = JSON.parse(readFileSync(join(dir, entry.file), 'utf8'));
    const s = validateScheme(raw);
    assert.equal(s.unknown.length, 0, entry.id + ' has unknown tokens: ' + s.unknown);
    // validation must not have dropped anything the author wrote
    assert.equal(Object.keys(s.tokens).length, Object.keys(raw.tokens).length, entry.id + ' lost day tokens');
    assert.equal(Object.keys(s.night).length, Object.keys(raw.night || {}).length, entry.id + ' lost night tokens');
    for (const mode of ['day', 'night']) {
      const r = resolveScheme(s, mode);
      assert.ok(tok(r, 'overlays.route'), entry.id + ' ' + mode + ' route');
      assert.ok(['dark', 'light'].includes(tok(r, 'basemap.base')), entry.id + ' ' + mode + ' base');
    }
  }
});

test('hillshade off → null hill', () => {
  const s = newScheme('H', '');
  s.tokens['basemap.hillshade'] = false;
  assert.equal(applyScheme(s).hill, null);
});
