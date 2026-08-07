/* Detail-level zoom bias (core/appliers/detail.js) — the transform is pure
   and id-whitelisted, and 'outback' pulls the real base style's tracks to
   the z12 data floor. Run: node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyDetailBias, DETAIL_BIAS, DETAIL_LAYER_IDS, DETAIL_LEVELS } from '../core/appliers/detail.js';

const here = dirname(fileURLToPath(import.meta.url));
const baseLayers = (file) =>
  JSON.parse(readFileSync(join(here, '..', 'core', 'basemap', file), 'utf8'));

test('populated and unknown levels are identity', () => {
  const layers = baseLayers('layers.json');
  assert.equal(applyDetailBias(layers, 'populated'), layers);
  assert.equal(applyDetailBias(layers, 'weird'), layers);
});

test('outback shifts track ramps two zooms earlier, pure copy', () => {
  const layers = baseLayers('layers.json');
  const before = JSON.stringify(layers);
  const out = applyDetailBias(layers, 'outback');
  assert.equal(JSON.stringify(layers), before, 'input mutated');

  const track = out.find((l) => l.id === 'roads_other');
  const orig = layers.find((l) => l.id === 'roads_other');
  // base ramp starts at z14 → outback starts at z12 (the tile-data floor)
  assert.equal(orig.paint['line-width'][3], 14);
  assert.equal(track.paint['line-width'][3], 12);
});

test('explicit minzoom shifts too (minor labels z15 → z13)', () => {
  const out = applyDetailBias(baseLayers('layers.json'), 'outback');
  assert.equal(out.find((l) => l.id === 'roads_labels_minor').minzoom, 13);
});

test('non-whitelisted layers are untouched (same references)', () => {
  const layers = baseLayers('layers.json');
  const out = applyDetailBias(layers, 'outback');
  for (let i = 0; i < layers.length; i++) {
    if (!DETAIL_LAYER_IDS.has(layers[i].id)) assert.equal(out[i], layers[i], layers[i].id);
    else assert.notEqual(out[i], layers[i], layers[i].id);
  }
});

test('every whitelisted id exists in both base flavours', () => {
  for (const file of ['layers.json', 'layers-light.json']) {
    const ids = new Set(baseLayers(file).map((l) => l.id));
    for (const id of DETAIL_LAYER_IDS) assert.ok(ids.has(id), `${id} missing from ${file}`);
  }
});

test('nested zoom ramps shift; value positions never touched', () => {
  const layers = [{ id: 'roads_minor', type: 'line', paint: {
    'line-color': ['case', ['has', 'x'],
      ['interpolate', ['linear'], ['zoom'], 11, '#111', 16, '#222'], '#333'],
    'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0, 12.5, 0.5],
  } }];
  const out = applyDetailBias(layers, 'regional');
  const c = out[0].paint['line-color'][2];
  assert.deepEqual(c.slice(3), [10, '#111', 15, '#222']);
  assert.deepEqual(out[0].paint['line-width'].slice(3), [10, 0, 11.5, 0.5]);
});

test('levels and biases stay in lockstep', () => {
  assert.deepEqual(DETAIL_LEVELS, Object.keys(DETAIL_BIAS));
  assert.equal(DETAIL_BIAS.outback, -2); // the z12 data floor — see detail.js
});
