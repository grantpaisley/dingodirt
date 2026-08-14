/* Nav rendered sweep — measures the ACTUAL menus, with schemes mounted.
 *
 * The matrix Grant asked for (2026-08-14, after the ink-on-ink schema
 * picker): every scheme × the menus OPEN. Each state drives the real UI —
 * the glove menu, the ride-schema picker, the settings panel — exactly the
 * click path a rider takes, so a chrome var that stops following the
 * mounted scheme fails here even when every static token pair passes.
 *
 * CONTRAST_ENFORCE=1 turns warnings into failures (same flag as the static
 * guard). Screenshots land in artifacts/ either way.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { collectTextStyles, contrastFailures } from './contrast-dom.mjs';

const NAV = 'http://localhost:8148';
const ENFORCE = process.env.CONTRAST_ENFORCE === '1';
const SCHEMES = ['factory', 'Classic', 'Google Maps', 'Waze', 'Locus Map', 'OziExplorer', 'DMD2'];
mkdirSync(new URL('./artifacts', import.meta.url).pathname, { recursive: true });

async function boot(page) {
  // External hosts abort for determinism — the shared tile archive, aerial
  // sources and ntfy are irrelevant to chrome contrast.
  await page.route(/https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(NAV);
  // S is a top-level const — a global binding, not a window property
  await page.waitForFunction(
    () => typeof S !== 'undefined' && typeof ddCore !== 'undefined',
    null, { timeout: 20_000 });
  // Fresh profile: the first-run wizard covers the app (its basemap
  // download is aborted with the other external hosts). Skip past it —
  // the wizard itself is a future sweep target of its own.
  const introSkip = page.locator('#introSkip');
  if (await introSkip.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await introSkip.click();
  }
  const suSkip = page.locator('#suSkip');
  if (await suSkip.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await suSkip.click();
  }
  await page.locator('#startup').waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {});
  // dismiss the SW update banner if it appears — it overlaps the HUD
  const later = page.locator('#updLater');
  if (await later.isVisible().catch(() => false)) await later.click();
}

/* Stopped-with-a-track chrome (FORWARD toggle, cue-edit pencil) floats over the
   map on near-opaque plates. Load a tiny local track through Nav's own import
   path so that state exists — the exact plate that shipped ink-on-dark under
   the light schemes (Grant's Locus screenshot, 2026-08-14). */
async function selectSweepTrack(page) {
  // a scheme apply swaps the map style and re-adds the overlay sources async —
  // selecting a track mid-swap hits refreshMapData with the sources missing
  await page.waitForFunction(
    () => typeof mapReady !== 'undefined' && mapReady && window.__map && __map.getSource('selSurf'),
    null, { timeout: 30_000 });
  await page.evaluate(async () => {
    let lat = -33.42, ele = 100;
    const pts = [];
    for (let i = 0; i < 20; i++) {
      pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="151.200000"><ele>${ele}</ele></trkpt>`);
      lat += 0.00045; if (i % 10 < 5) ele += 10;
    }
    await addFile('sweep.gpx',
      `<?xml version="1.0"?><gpx version="1.1"><trk><name>sweep track</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`);
    selectTrack(S.tracks.findIndex((t) => t.name === 'sweep track'));
  });
}

const openGlove = async (page) => {
  await page.locator('#menuBtn').click();
  await expect(page.locator('#gloveOverlay')).toBeVisible();
};

const gloveTile = (page, label) =>
  page.locator('#gloveGrid > *').filter({ hasText: label }).first();

async function applyScheme(page, name) {
  await openGlove(page);
  await gloveTile(page, 'Schema').click();
  await expect(page.locator('#schemaPicker')).toBeVisible();
  await page.locator('#schSchemes > *').filter({ hasText: name }).first().click();
  await expect(page.locator('#schemaPicker')).toBeHidden();
}

async function measure(page, state, results) {
  const samples = await page.evaluate(collectTextStyles);
  const { failures, skipped, measured } = contrastFailures(samples, state);
  await page.screenshot({
    path: new URL(`./artifacts/nav-${state.replace(/[^a-z0-9-]+/gi, '_')}.png`, import.meta.url).pathname,
  });
  results.push(...failures);
  console.log(`  ${state}: ${measured} measured, ${skipped} over-map skipped, ${failures.length} failing`);
}

for (const scheme of SCHEMES) {
  test(`nav menus readable — ${scheme}`, async ({ page }) => {
    const results = [];
    await boot(page);
    if (scheme !== 'factory') await applyScheme(page, scheme);

    await measure(page, `${scheme}-main`, results);

    await selectSweepTrack(page);
    await expect(page.locator('#revToggle')).toBeVisible();
    await measure(page, `${scheme}-track-selected`, results);

    await openGlove(page);
    await measure(page, `${scheme}-glove-menu`, results);

    await gloveTile(page, 'Schema').click();
    await expect(page.locator('#schemaPicker')).toBeVisible();
    await measure(page, `${scheme}-schema-picker`, results);
    await page.locator('#schemaClose').click();

    await openGlove(page);
    await gloveTile(page, 'Settings').click();
    await expect(page.locator('#panel')).toBeVisible();
    await measure(page, `${scheme}-settings`, results);

    if (ENFORCE) expect(results, results.join('\n')).toEqual([]);
    else if (results.length) console.warn(`WARN (report-only):\n${results.join('\n')}`);
  });
}

// factory daylight — the Day tile cycles the base style; body.daymode
// re-skins the settings panel, historically its own contrast trap.
test('nav menus readable — factory daylight', async ({ page }) => {
  const results = [];
  await boot(page);
  await openGlove(page);
  await gloveTile(page, 'Day').click();
  await page.waitForTimeout(400);

  await measure(page, 'daylight-main', results);

  await openGlove(page);
  await measure(page, 'daylight-glove-menu', results);

  await gloveTile(page, 'Settings').click();
  await expect(page.locator('#panel')).toBeVisible();
  await measure(page, 'daylight-settings', results);

  if (ENFORCE) expect(results, results.join('\n')).toEqual([]);
  else if (results.length) console.warn(`WARN (report-only):\n${results.join('\n')}`);
});
