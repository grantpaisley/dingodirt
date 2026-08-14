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
  // no daemon in the sweep: API calls fail fast and the app shows its
  // empty/error states — those are exactly the texts worth measuring.
  await page.route('**/api/**', (r) => r.abort());
  await page.route(/https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(PLAN);
  await page.waitForSelector('.left-pane', { timeout: 20_000 });
  await page.waitForTimeout(800);
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

test('plan chrome readable — main, tabs, settings', async ({ page }) => {
  const results = [];
  await boot(page);

  await measure(page, 'main', results);

  // list-view tabs (Places / Tracks) — bone-fill actives per Rule 7
  await page.locator('.list-toggle', { hasText: 'Tracks' }).first().click();
  await page.waitForTimeout(300);
  await measure(page, 'tracks-view', results);

  // settings panel via the map toolbar gear
  const gear = page.locator('.map-toolbar button, [class*="toolbar"] button').filter({ hasText: /settings/i });
  const gearIcon = (await gear.count()) ? gear.first() : page.locator('button[title*="ettings"]').first();
  if (await gearIcon.isVisible().catch(() => false)) {
    await gearIcon.click();
    await page.waitForTimeout(300);
    await measure(page, 'settings', results);
  }

  if (ENFORCE) expect(results, results.join('\n')).toEqual([]);
  else if (results.length) console.warn(`WARN (report-only):\n${results.join('\n')}`);
});
