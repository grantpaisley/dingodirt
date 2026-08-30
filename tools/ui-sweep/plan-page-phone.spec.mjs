/* Share-page phone shell — the four-tab bar, the sheet, and level 3
 * (docs/plans/2026-08-30-track-graph-and-phone-plan-design.md).
 *
 * The page reads a published pack out of the site database, so this spec
 * cannot run in CI without one. Point it at a running site and a real plan
 * token to use it:
 *
 *   PLAN_PAGE_URL=http://localhost:3111/p/<token> npx playwright test plan-page-phone
 *
 * Without PLAN_PAGE_URL every test skips, so the default sweep is unchanged.
 */
import { test, expect } from '@playwright/test';

const URL_ = process.env.PLAN_PAGE_URL;
const NAV = 'nav[aria-label="Plan sections"]';
const SHEET = '[data-testid="plan-sheet"]';

test.skip(!URL_, 'set PLAN_PAGE_URL to a published plan pack to run this spec');

async function boot(page) {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  // The Next dev overlay portal covers the bottom-left tab and eats clicks.
  await page.addStyleTag({ content: 'nextjs-portal{display:none !important}' });
  await page.waitForSelector(NAV, { timeout: 30_000 });
  await page.waitForTimeout(1500);
}

const box = (page, sel) => page.locator(sel).first().boundingBox();

for (const [name, width, height] of [
  ['portrait', 390, 844],
  ['landscape', 844, 390],
]) {
  test.describe(name, () => {
    test.use({ viewport: { width, height } });

    test('the tab bar is on screen and the sheet starts down', async ({ page }) => {
      await boot(page);
      const nav = await box(page, NAV);
      expect(await page.locator(SHEET).count()).toBe(0);
      if (name === 'portrait') {
        // The bar is a bar, and its foot is the foot of the viewport — the
        // bug this guards is a bar pushed below the fold by page chrome.
        expect(Math.round(nav.height)).toBe(56);
        expect(Math.round(nav.y + nav.height)).toBeLessThanOrEqual(height);
      } else {
        // Landscape docks it as a rail. A phone is ~844 px wide here, so
        // this also guards the shell test against a plain max-width query.
        expect(Math.round(nav.width)).toBe(56);
        expect(Math.round(nav.x)).toBe(0);
      }
    });

    test('a tab raises the sheet, and level 3 does not grow it', async ({ page }) => {
      await boot(page);
      await page.getByRole('button', { name: 'Map', exact: true }).click();
      await page.waitForSelector(SHEET);
      const level2 = await box(page, SHEET);
      const map = await box(page, '.maplibregl-map');
      if (name === 'portrait') {
        expect(level2.height).toBeLessThanOrEqual(map.height * 0.56);
      } else {
        expect(Math.round(level2.width)).toBeLessThanOrEqual(320);
      }

      await page.getByRole('button', { name: /^Base map/ }).click();
      await expect(page.getByRole('button', { name: /^Topo/ })).toBeVisible();
      const level3 = await box(page, SHEET);
      expect(level3.height).toBeLessThanOrEqual(level2.height);
      expect(Math.round(level3.width)).toBe(Math.round(level2.width));
    });

    test('a track row opens its own page inside the sheet', async ({ page }) => {
      await boot(page);
      await page.getByRole('button', { name: 'Tracks', exact: true }).click();
      await page.waitForSelector(`${SHEET} [id^="plan-track-"]`);
      await page.locator(`${SHEET} [id^="plan-track-"]`).first().click();
      await expect(page.getByRole('button', { name: 'Show on map' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    });
  });
}
