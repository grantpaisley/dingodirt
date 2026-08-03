/* Behaviour-profile contract tests (nav-behavior framework, 2026-08-03):
   - unknown params ignored (but carried), missing params defaulted
   - malformed / major-version-mismatch rejected
   - curve type validated (sorted, bounded)
   - every bundled preset validates losslessly
   Run: node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBehavior, newBehavior, bv, behaviorWarnings,
  BEHAVIOR_SCHEMA_VERSION, PARAM_DEFS } from '../js/behavior.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

test('newBehavior carries defaults for every param', () => {
  const b = newBehavior('X', 'Y');
  for (const [k, def] of Object.entries(PARAM_DEFS))
    assert.deepEqual(b.params[k], def.def, k);
});

test('missing params default through bv()', () => {
  const b = { schemaVersion: BEHAVIOR_SCHEMA_VERSION, params: {} };
  assert.equal(bv(b, 'offroute.detectM'), 60);
  assert.equal(bv(b, 'camera.followMode'), 'courseUp');
  assert.deepEqual(bv(b, 'camera.zoomCurve'), [[0, 300], [30, 900], [70, 2500]]);
});

test('unknown params are kept but flagged, bad values dropped', () => {
  const b = validateBehavior({ schemaVersion: '1.0', name: 'T', params: {
    'future.thing': 42, 'offroute.detectM': 'far', 'camera.pitch': 999,
    'reroute.mode': 'teleport', 'guidance.stackCues': true } });
  assert.deepEqual(b.unknown, ['future.thing']);
  assert.equal(b.params['future.thing'], 42);            // round-trips for newer apps
  assert.equal(b.params['offroute.detectM'], undefined); // bad number dropped
  assert.equal(b.params['camera.pitch'], 60);            // clamped to max
  assert.equal(b.params['reroute.mode'], undefined);     // bad select dropped
  assert.equal(b.params['guidance.stackCues'], true);
});

test('curve values validated: sorted, malformed dropped', () => {
  const good = validateBehavior({ schemaVersion: '1.0', params: {
    'camera.zoomCurve': [[70, 2500], [0, 300], [30, 900]] } });
  assert.deepEqual(good.params['camera.zoomCurve'], [[0, 300], [30, 900], [70, 2500]]); // sorted
  for (const bad of [[[0]], [['a', 1]], [[0, 5]], [], 'nope', [[0, 300], [-5, 900]]]) {
    const b = validateBehavior({ schemaVersion: '1.0', params: { 'camera.zoomCurve': bad } });
    assert.equal(b.params['camera.zoomCurve'], undefined, JSON.stringify(bad));
  }
});

test('major version mismatch rejected with a plain message', () => {
  assert.throws(() => validateBehavior({ schemaVersion: '2.0', params: {} }), /schema v2/);
  assert.throws(() => validateBehavior({ params: {} }), /schemaVersion/);
  assert.throws(() => validateBehavior('nope'), /bad JSON/);
});

test('warnings surface documented bad combos without rejecting', () => {
  const b = newBehavior('W', '');
  b.params['guidance.strictOrder'] = true;
  b.params['reroute.mode'] = 'pointPriority';
  b.params['offroute.rejoinM'] = 80;   // >= detectM 60
  const w = behaviorWarnings(b);
  assert.ok(w.some(m => /point-priority/.test(m)));
  assert.ok(w.some(m => /hysteresis/.test(m)));
  assert.deepEqual(behaviorWarnings(newBehavior('ok', '')), []);
});

test('every bundled preset validates losslessly', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'behaviors');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  assert.ok(index.length >= 5);
  for (const entry of index) {
    const raw = JSON.parse(readFileSync(join(dir, entry.file), 'utf8'));
    const b = validateBehavior(raw);
    assert.equal(b.unknown.length, 0, entry.id + ' has unknown params: ' + b.unknown);
    // validation must not have dropped anything the author wrote
    assert.equal(Object.keys(b.params).length, Object.keys(raw.params).length, entry.id + ' lost params');
    assert.deepEqual(behaviorWarnings(b), [], entry.id + ' has warnings');
    assert.ok(['track', 'turnByTurn', 'routeGuidance', 'bearing'].includes(bv(b, 'guidance.mode')), entry.id);
  }
});

test('default preset matches registry defaults exactly (empty profile = no change)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'behaviors');
  const raw = JSON.parse(readFileSync(join(dir, 'default.json'), 'utf8'));
  const b = validateBehavior(raw);
  for (const k of Object.keys(raw.params))
    assert.deepEqual(b.params[k], PARAM_DEFS[k].def, k + ' drifted from registry default');
});
