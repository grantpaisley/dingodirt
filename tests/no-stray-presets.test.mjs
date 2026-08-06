/* Preset drift guard.
 *
 * core/schemes, core/behaviors and core/appliers hold the ONLY copies. Before
 * the monorepo these existed in three places kept aligned by a cross-repo
 * workflow and a PAT; the whole point of consolidating was to make that
 * impossible to undo by accident.
 *
 * An app consumes them through a symlink into core/. Deploy artefacts get
 * real files because the assembly step dereferences (cp -RL) — see
 * tools/assemble-app.sh. So a REAL directory here means someone vendored a
 * copy back in, and this test fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, lstatSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE = join(REPO, 'core');
const APPS = join(REPO, 'apps');

/** Every path an app is allowed to reach presets/appliers through, and the
 *  core/ path it must resolve to. */
const LINKS = [
  ['apps/nav/schemes', 'core/schemes'],
  ['apps/nav/behaviors', 'core/behaviors'],
  ['apps/studio/schemes', 'core/schemes'],
  ['apps/studio/behaviors', 'core/behaviors'],
  ['apps/plan/public/schemes', 'core/schemes'],
  ['apps/plan/public/behaviors', 'core/behaviors'],
  ['apps/studio/js/applier-nav.js', 'core/appliers/applier-nav.js'],
  ['apps/studio/js/scheme.js', 'core/appliers/scheme.js'],
];

test('core holds the canonical presets', () => {
  for (const d of ['schemes', 'behaviors', 'appliers']) {
    const p = join(CORE, d);
    assert.ok(existsSync(p), `core/${d} is missing`);
    assert.ok(lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink(),
      `core/${d} must be a real directory — it is the canonical copy`);
    assert.ok(readdirSync(p).length > 0, `core/${d} is empty`);
  }
});

test('every app reaches presets through a symlink into core/', () => {
  for (const [linkPath, target] of LINKS) {
    const abs = join(REPO, linkPath);
    assert.ok(existsSync(abs), `${linkPath} is missing`);
    assert.ok(lstatSync(abs).isSymbolicLink(),
      `${linkPath} must be a symlink into core/, not a vendored copy. ` +
      `If you meant to add a preset, add it to ${target} instead.`);
    assert.equal(realpathSync(abs), join(REPO, target),
      `${linkPath} resolves to the wrong place`);
  }
});

test('no app has vendored its own preset or applier copy', () => {
  const allowed = new Set(LINKS.map(([l]) => join(REPO, l)));
  const strays = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      // don't descend into build output or dependencies
      if (['node_modules', 'dist', '.next', 'target', '.git', 'vendor', 'basemap'].includes(entry.name)) continue;
      if (allowed.has(abs)) continue;

      if (entry.isSymbolicLink()) {
        // a symlink we didn't declare is still drift — flag it
        const real = existsSync(abs) ? realpathSync(abs) : null;
        if (real && (real.startsWith(join(CORE, 'schemes')) || real.startsWith(join(CORE, 'behaviors')) ||
                     real.startsWith(join(CORE, 'appliers')))) {
          strays.push(`${abs.slice(REPO.length + 1)} (undeclared symlink into core/)`);
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (entry.name === 'schemes' || entry.name === 'behaviors') {
          // a real schemes/ or behaviors/ dir holding preset JSON is a vendored copy
          const json = readdirSync(abs).filter(f => f.endsWith('.json'));
          if (json.length > 0) strays.push(`${abs.slice(REPO.length + 1)} (${json.length} preset JSON files)`);
          continue;
        }
        walk(abs);
      } else if (entry.name === 'applier-nav.js' || entry.name === 'scheme.js') {
        strays.push(`${abs.slice(REPO.length + 1)} (applier/vocabulary copy)`);
      }
    }
  };

  walk(APPS);

  assert.deepEqual(strays, [],
    `Vendored preset/applier copies found. core/ holds the only copy; apps ` +
    `link to it.\n  ${strays.join('\n  ')}`);
});

test('the retired cross-repo sync is gone', () => {
  // These kept three copies aligned via a PAT. The monorepo replaced them;
  // if they come back, so does the drift they were papering over.
  for (const p of ['apps/studio/sync-appliers.sh', 'apps/studio/.github/workflows/sync-appliers.yml']) {
    assert.ok(!existsSync(join(REPO, p)),
      `${p} was retired by the monorepo migration — presets are shared via core/ now`);
  }
});
