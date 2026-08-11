/* UI contrast guard — Stage 1 of the merge-gate readability checks.
 *
 * Measures WCAG 2.1 contrast for every declared foreground/background pair in
 * the places colours enter the apps: core/ui tokens (dark + light), every
 * .dingoscheme (day + night), and each app's chrome palette. Thresholds:
 * 4.5:1 for normal text (WCAG 1.4.3), 3:1 for accents and status glyphs
 * (WCAG 1.4.11). Hairline borders are deliberately exempt.
 *
 * REPORT-ONLY by default: low-contrast pairs print as WARN diagnostics and the
 * suite stays green. Set CONTRAST_ENFORCE=1 to turn warnings into failures.
 * Structural errors (missing token, unparseable colour, renamed CSS block)
 * always fail — those mean a refactor broke the guard, not a design judgement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveScheme, validateScheme, TOKEN_DEFS } from '../core/appliers/scheme.js';
import { contrastRatio, parseCssVarBlock, resolveVarRefs } from '../tools/contrast.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENFORCE = process.env.CONTRAST_ENFORCE === '1';

const NORMAL = 4.5; // body/label text
const LARGE = 3;    // large text, accents, non-text UI (status glyphs)

const failures = [];

/** Check one pair table against a lookup. Missing/unparseable tokens fail hard;
 *  low ratios warn (or fail under CONTRAST_ENFORCE=1). */
function checkPairs(t, source, lookup, pairs) {
  for (const [fgName, bgName, min] of pairs) {
    let fg, bg, ratio;
    try {
      fg = lookup(fgName);
      bg = lookup(bgName);
      assert.ok(fg, `${source}: ${fgName} is missing`);
      assert.ok(bg, `${source}: ${bgName} is missing`);
      ratio = contrastRatio(fg, bg);
    } catch (e) {
      assert.fail(`${source}: ${fgName} on ${bgName} — ${e.message}`);
    }
    if (ratio < min) {
      const line = `${source}: ${fgName} (${fg}) on ${bgName} (${bg}) = ${ratio.toFixed(2)}:1 — needs ${min}:1`;
      failures.push(line);
      t.diagnostic(`WARN ${line}`);
      if (ENFORCE) assert.fail(line);
    }
  }
}

test('contrast maths sanity', () => {
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  const grey = contrastRatio('#777777', '#ffffff');
  assert.ok(Math.abs(grey - 4.48) < 0.01, `#777 on white ≈ 4.48, got ${grey}`);
});

/* ---- A. core/ui/tokens.css — dark (:root) and light (merged override) ---- */
test('contrast: core/ui tokens', (t) => {
  const css = readFileSync(join(REPO, 'core/ui/tokens.css'), 'utf8');
  const dark = resolveVarRefs(parseCssVarBlock(css, ':root'));
  const light = resolveVarRefs(new Map([
    ...parseCssVarBlock(css, ':root'),
    ...parseCssVarBlock(css, ':root[data-mode="light"]'),
  ]));

  const pairs = [];
  for (const fg of ['--dd-text', '--dd-text-dim']) {
    for (const bg of ['--dd-surface-0', '--dd-surface-1', '--dd-surface-2']) pairs.push([fg, bg, NORMAL]);
  }
  pairs.push(['--dd-on-accent', '--dd-accent', NORMAL], ['--dd-on-accent', '--dd-accent-hot', NORMAL]);
  pairs.push(['--dd-on-toggle', '--dd-toggle-fill', NORMAL]);
  for (const s of ['ok', 'mid', 'bad']) pairs.push([`--dd-on-status-${s}`, `--dd-status-${s}`, NORMAL]);
  for (const s of ['ok', 'warn', 'bad']) pairs.push([`--dd-on-alert-${s}`, `--dd-alert-${s}`, NORMAL]);
  for (const bg of ['--dd-surface-0', '--dd-surface-1']) {
    pairs.push(['--dd-accent', bg, LARGE]);
    for (const s of ['ok', 'warn', 'bad']) pairs.push([`--dd-alert-${s}`, bg, LARGE]);
  }
  // --dd-status-* chip fills are NOT checked against surfaces: status chips are
  // muted by design (Rule 11) and carry their information in their text, which
  // IS checked at 4.5:1 above. Alerts stay checked — they interrupt via colour.

  // completeness guard: every on-* token must be exercised as a foreground
  const fgs = new Set(pairs.map(([fg]) => fg));
  for (const k of dark.keys()) {
    if (k.startsWith('--dd-on-')) assert.ok(fgs.has(k), `pair table drift: ${k} is never checked`);
  }

  checkPairs(t, 'tokens.css dark', (k) => dark.get(k), pairs);
  checkPairs(t, 'tokens.css light', (k) => light.get(k), pairs);
});

/* ---- B. core/schemes/*.json — every scheme, day AND night resolution ---- */
test('contrast: schemes (day + night)', (t) => {
  const index = JSON.parse(readFileSync(join(REPO, 'core/schemes/index.json'), 'utf8'));
  assert.ok(index.length > 0, 'core/schemes/index.json is empty');

  const pairs = [
    ['hud.text', 'hud.panel', NORMAL], ['hud.text', 'hud.bg', NORMAL],
    ['hud.dim', 'hud.panel', NORMAL],
    ['hud.ok', 'hud.panel', LARGE], ['hud.warn', 'hud.panel', LARGE], ['hud.bad', 'hud.panel', LARGE],
    ['hud.accent', 'hud.panel', LARGE],
  ];

  // completeness guard: every colour-typed hud token is covered (hud.arrow is a
  // map overlay, not chrome — measured by the Stage 2 rendered sweep instead)
  const used = new Set(pairs.flat().filter((x) => typeof x === 'string'));
  for (const [k, def] of Object.entries(TOKEN_DEFS)) {
    if (k.startsWith('hud.') && def.type === 'color' && k !== 'hud.arrow') {
      assert.ok(used.has(k), `pair table drift: ${k} is never checked`);
    }
  }

  for (const entry of index) {
    const scheme = validateScheme(JSON.parse(readFileSync(join(REPO, 'core/schemes', entry.file), 'utf8')));
    for (const mode of ['day', 'night']) {
      const r = resolveScheme(scheme, mode);
      const lookup = (k) => r.tokens[k] ?? TOKEN_DEFS[k]?.def;
      checkPairs(t, `scheme ${entry.id} ${mode}`, lookup, pairs);
    }
  }
});

/* ---- C. apps/plan chrome palette ---- */
test('contrast: Plan chrome', (t) => {
  const css = readFileSync(join(REPO, 'apps/plan/src/App.css'), 'utf8');
  const vars = resolveVarRefs(parseCssVarBlock(css, ':root'));
  checkPairs(t, 'plan App.css', (k) => vars.get(k), [
    ['--text-primary', '--pane-bg', NORMAL], ['--text-primary', '--bg-dark', NORMAL],
    ['--text-secondary', '--pane-bg', NORMAL], ['--text-secondary', '--bg-dark', NORMAL],
    ['--accent', '--pane-bg', LARGE],
  ]);
});

/* ---- D. apps/nav chrome — night :root and the daymode settings panel ---- */
test('contrast: Nav chrome (night + day)', (t) => {
  const html = readFileSync(join(REPO, 'apps/nav/index.html'), 'utf8');
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(style, 'apps/nav/index.html has no <style> block');

  const varPairs = [
    ['--fg', '--bg', NORMAL], ['--fg', '--panel', NORMAL], ['--fg', '--panel2', NORMAL],
    ['--dim', '--bg', NORMAL], ['--dim', '--panel', NORMAL],
    ['--ok', '--panel', LARGE], ['--warn', '--panel', LARGE], ['--bad', '--panel', LARGE],
    ['--accent', '--panel', LARGE],
  ];

  const night = resolveVarRefs(parseCssVarBlock(style, ':root'));
  checkPairs(t, 'nav night', (k) => night.get(k), varPairs);

  // day = cascade for elements inside the settings panel: :root, then the
  // body.daymode override (--accent), then body.daymode #panel's redefinitions
  const day = resolveVarRefs(new Map([
    ...night,
    ...parseCssVarBlock(style, 'body.daymode'),
    ...parseCssVarBlock(style, 'body.daymode #panel'),
  ]));
  checkPairs(t, 'nav daymode panel', (k) => day.get(k), varPairs);

  // literal daymode plates (declared inline in their rules, not as vars)
  const literals = [
    ['#1d1d1f', '#f5f5f7', NORMAL], // .ctl glyphs on day plates
    ['#15202b', '#f5f7f9', NORMAL], // #bottom bar text on its frosted plate
  ];
  checkPairs(t, 'nav daymode literals', (k) => k, literals);
});

/* ---- E. apps/site palette ---- */
test('contrast: Site chrome', (t) => {
  const css = readFileSync(join(REPO, 'apps/site/app/globals.css'), 'utf8');
  const vars = resolveVarRefs(parseCssVarBlock(css, ':root'));
  checkPairs(t, 'site globals.css', (k) => vars.get(k), [
    ['--bone', '--ink', NORMAL], ['--bone', '--ink-2', NORMAL], ['--bone', '--ink-3', NORMAL],
    ['--bone-dim', '--ink', NORMAL], ['--bone-dim', '--ink-2', NORMAL],
    ['--clay-hot', '--ink', LARGE],
  ]);
});

/* ---- summary ---- */
test('contrast summary', (t) => {
  if (failures.length === 0) {
    t.diagnostic('all declared pairs pass');
    return;
  }
  t.diagnostic(`${failures.length} low-contrast pair(s) found:`);
  for (const line of failures) t.diagnostic(`  ${line}`);
  if (!ENFORCE) t.diagnostic('report-only — set CONTRAST_ENFORCE=1 to make these block the merge');
});
