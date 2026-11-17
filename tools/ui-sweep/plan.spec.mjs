/* Plan rendered sweep — the built app (vite preview), daemon stubbed out.
 *
 * Lighter matrix than Nav: Plan's chrome is one dark theme driven by the
 * core/ui tokens (ladder PR 3), so the sweep guards the main surfaces and
 * the menus rather than a scheme matrix. Ride-scheme chrome overrides
 * (applierPlan) ride the same vars and get covered by the Nav matrix.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { collectTextStyles, contrastFailures } from './contrast-dom.mjs';

const PLAN = 'http://localhost:4173';
const ENFORCE = process.env.CONTRAST_ENFORCE === '1';
mkdirSync(new URL('./artifacts', import.meta.url).pathname, { recursive: true });

async function boot(page) {
  // no daemon in the sweep: every API call answers an empty list, so the app
  // shows its empty states. (Aborted calls left the list pane on "Loading..."
  // through the query retries, so the list tabs never rendered — 2026-11-18.)
  await page.route('**/api/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  // (the last matching route wins) — endpoints that answer an object, not a list
  await page.route(/\/api\/packs(\?|$)/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"packs":[]}' }));
  await page.route(/https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(PLAN);
  await page.waitForSelector('.left-pane', { timeout: 20_000 });
  await page.waitForSelector('.list-toggle', { timeout: 20_000 });
  await page.waitForTimeout(300);
}

async function measure(page, state, results) {
  const samples = await page.evaluate(collectTextStyles);
  const { failures, skipped, measured } = contrastFailures(samples, state);
  await page.screenshot({
    path: new URL(`./artifacts/plan-${state}.png`, import.meta.url).pathname,
  });
  results.push(...failures);
  console.log(`  ${state}: ${measured} measured, ${skipped} over-map skipped, ${failures.length} failing`);
}

/* every list view, the import dialog and every map-toolbar pane (2026-11-18, Grant:
   "check all screens, all modes, all settings"). The old settings step looked for a
   button with the TEXT "settings" — the toolbar buttons are icon-only with a title,
   so it never ran. Toolbar buttons are found by the start of their title. */
// Basket last: its view swaps the tab row (and the import button) out
const LIST_VIEWS = ['Map area', 'Places', 'Tracks', 'Packs', 'Basket'];
const TOOL_PANES = [
  ['track-types', 'Track types'], ['layers', 'Map layers'], ['heatmap-style', 'Heatmap style'],
  ['colour', 'Colour tracks by'], ['view-options', 'View options'], ['filters', 'Filter by HR'],
  ['colour-scale', 'Colour scale boundaries'],
];
const SIZES = { desktop: { width: 1280, height: 800 }, laptop: { width: 1024, height: 640 } };

for (const [size, vp] of Object.entries(SIZES)) {
  test(`plan chrome readable — every view, dialog and pane · ${size}`, async ({ page }) => {
    const results = [];
    await page.setViewportSize(vp);
    await boot(page);
    await measure(page, `${size}-main`, results);

    const imp = page.locator('button[title^="Import external"]').first();
    if (await imp.isVisible().catch(() => false)) {
      await imp.click();
      await page.waitForTimeout(300);
      await measure(page, `${size}-import-dialog`, results);
      await page.keyboard.press('Escape');
      const cancel = page.locator('button').filter({ hasText: /^(Cancel|Close)$/ }).first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
      await page.waitForTimeout(200);
    } else results.push(`[${size}] import button not found`);

    for (const v of LIST_VIEWS) {
      const tab = page.locator('.list-toggle').filter({ hasText: new RegExp(`^${v}`) }).first();
      if (!(await tab.isVisible().catch(() => false))) { results.push(`[${size}] list tab "${v}" not found`); continue; }
      await tab.click();
      // the Tracks view refetches and shows "Loading..." without the tab row for a moment
      await page.waitForSelector('.list-toggle', { timeout: 20_000 });
      await page.waitForTimeout(300);
      await measure(page, `${size}-list-${v.replace(/ /g, '-').toLowerCase()}`, results);
    }

    for (const [key, title] of TOOL_PANES) {
      const btn = page.locator(`button[title^="${title}"]`).first();
      if (!(await btn.isVisible().catch(() => false))) { results.push(`[${size}] toolbar "${title}" not found`); continue; }
      await btn.click();
      await page.waitForTimeout(300);
      await measure(page, `${size}-pane-${key}`, results);
      await btn.click(); // close it again
      await page.waitForTimeout(150);
    }

    if (ENFORCE) expect(results, results.join('\n')).toEqual([]);
    else if (results.length) console.warn(`WARN (report-only):\n${results.join('\n')}`);
  });
}
