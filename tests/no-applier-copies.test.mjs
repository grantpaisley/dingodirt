/* Applier drift guard.
 *
 * core/appliers holds the ONLY implementation of scheme→paint. Nav loads it
 * as an ES module through the apps/nav/appliers symlink; Plan and the site
 * import it by path. Until 2026-08-14 Nav carried an inline hand-translation
 * and Plan a defaults copy — they drifted (overlays.breadcrumb, PR #26's
 * detail bias). This test fails if any hand copy comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('apps/nav/appliers is a symlink into core/appliers', () => {
  const link = join(REPO, 'apps/nav/appliers');
  assert.ok(lstatSync(link).isSymbolicLink(), 'apps/nav/appliers must be a symlink');
  assert.equal(realpathSync(link), join(REPO, 'core/appliers'));
});

test('Nav index.html carries no inline applier copy', () => {
  const html = readFileSync(join(REPO, 'apps/nav/index.html'), 'utf8');
  // Signatures of the deleted hand-translations. Delegates that CALL
  // ddCore.* are fine; redefining the tables/algorithms is not.
  for (const marker of [
    'const SCHEME_D =',
    'const SCHEME_BASE_MAP =',
    'const SCHEME_CSS =',
    'const DETAIL_LAYER_IDS =',
    'function shiftZoomStops',
  ]) {
    assert.ok(!html.includes(marker),
      `apps/nav/index.html re-grew an applier copy: found "${marker}" — use core/appliers via window.ddCore instead`);
  }
  assert.ok(html.includes("import * as applier from './appliers/applier-nav.js'"),
    'Nav must load the canonical applier module');
});

test('Nav sw.js precaches the applier modules', () => {
  const sw = readFileSync(join(REPO, 'apps/nav/sw.js'), 'utf8');
  for (const f of ['./appliers/applier-nav.js', './appliers/scheme.js', './appliers/detail.js'])
    assert.ok(sw.includes(`'${f}'`), `sw.js SHELL must precache ${f} for offline`);
});

test('Plan carries no token-defaults copy', () => {
  const ts = readFileSync(join(REPO, 'apps/plan/src/scheme/scheme.ts'), 'utf8');
  assert.ok(!ts.includes('SCHEME_DEFAULTS'),
    'apps/plan scheme.ts re-grew a defaults copy — re-export tok from core/appliers/scheme.js instead');
  assert.ok(ts.includes("core/appliers/scheme.js"),
    'Plan must source tok from the canonical registry');
});
