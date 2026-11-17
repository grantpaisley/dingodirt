/* Nav ride-screen sweep — every look × every layout × every screen.
 *
 * Grant, 2026-11-18: "test visibility for ALL schemas. check all screens, all
 * modes, all settings for all schema". nav.spec.mjs covers the menus per
 * scheme at desktop size; this spec adds the matrix around it:
 *
 *   looks    factory on each base style (Day, Trail, Dark, Sat) + each scheme
 *   layouts  portrait phone, landscape phone, half phone (split screen)
 *   screens  stopped (turn cell idle, START bar, map credit), riding (turn cell
 *            pale / countdown / near / hazard / seconds / off track, Profile on,
 *            the ☰ ride menu), every dialog and sheet, every settings tab with
 *            the advanced tabs on
 *
 * Text over the map is measured through the halo model in contrast-dom.mjs
 * (text-shadow colour = local background). Ride states are set straight into
 * the turn-cell renderer (setHud) so each state is deterministic — no GPS, no
 * demo timing. CONTRAST_ENFORCE=1 turns warnings into failures.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { collectTextStyles, contrastFailures } from './contrast-dom.mjs';

const NAV = 'http://localhost:8148';
const ENFORCE = process.env.CONTRAST_ENFORCE === '1';
const LOOKS = [
  'factory:daylight', 'factory:contrast', 'factory:dark', 'factory:satellite',
  'Classic', 'Google Maps', 'Waze', 'Locus Map', 'OziExplorer', 'DMD2',
];
const LAYOUTS = {
  portrait: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
  half: { width: 400, height: 430 },
};
mkdirSync(new URL('./artifacts', import.meta.url).pathname, { recursive: true });
// 30 independent cases (~21 s each): let the workers share them
test.describe.configure({ mode: 'parallel' });

async function boot(page, results, tag) {
  await page.route(/https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(NAV);
  await page.waitForFunction(() => typeof S !== 'undefined' && typeof ddCore !== 'undefined',
    null, { timeout: 20_000 });
  // the first-run wizard is a screen too — measure it once per run before skipping
  const introSkip = page.locator('#introSkip');
  if (await introSkip.isVisible({ timeout: 2_000 }).catch(() => false)) {
    if (results) await measure(page, `${tag}-first-run`, results);
    await introSkip.click();
  }
  const suSkip = page.locator('#suSkip');
  if (await suSkip.isVisible({ timeout: 8_000 }).catch(() => false)) {
    if (results) await measure(page, `${tag}-startup`, results);
    await suSkip.click();
  }
  await page.locator('#startup').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  const later = page.locator('#updLater');
  if (await later.isVisible().catch(() => false)) await later.click();
  await page.waitForFunction(() => typeof mapReady !== 'undefined' && mapReady,
    null, { timeout: 30_000 });
}

const openGlove = async (page) => {
  await page.evaluate(() => { if (!gloveOverlay.classList.contains('on')) openGlove(); });
  await expect(page.locator('#gloveOverlay')).toBeVisible();
};
const closeGloveP = (page) => page.evaluate(() => closeGlove());
const gloveTile = (page, label) => page.locator('#gloveGrid > *').filter({ hasText: label }).first();

async function applyLook(page, look) {
  if (look.startsWith('factory:')) {
    await page.evaluate((v) => setMapStyle(v), look.slice(8));
    await page.waitForTimeout(500);
    return;
  }
  await openGlove(page);
  await gloveTile(page, 'Schema').click();
  await expect(page.locator('#schemaPicker')).toBeVisible();
  await page.locator('#schSchemes > *').filter({ hasText: look }).first().click();
  await expect(page.locator('#schemaPicker')).toBeHidden();
}

/* a short local track with elevation (Profile has something to draw) */
async function selectSweepTrack(page) {
  await page.waitForFunction(() => window.__map && __map.getSource('selSurf'), null, { timeout: 30_000 });
  await page.evaluate(async () => {
    let lat = -33.42, ele = 100;
    const pts = [];
    for (let i = 0; i < 40; i++) {
      pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="151.200000"><ele>${ele}</ele></trkpt>`);
      lat += 0.00045; ele += i % 10 < 5 ? 10 : -6;
    }
    await addFile('sweep.gpx',
      `<?xml version="1.0"?><gpx version="1.1"><trk><name>Sweep track with a long name for the cell</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`);
    selectTrack(S.tracks.findIndex((t) => t.name.startsWith('Sweep track')));
    // the same refreshes a real file load runs (else the empty card stays up)
    refreshTrackList(); refreshEmpty(); updateBottomBar(); refreshMapData();
  });
}

async function measure(page, state, results) {
  await page.waitForTimeout(150);
  const samples = await page.evaluate(collectTextStyles);
  const { failures, skipped, measured } = contrastFailures(samples, state);
  await page.screenshot({
    path: new URL(`./artifacts/ride-${state.replace(/[^a-z0-9-]+/gi, '_')}.png`, import.meta.url).pathname,
  });
  results.push(...failures);
  // reach check: a visible button cut off by the screen edge must sit in a box that
  // scrolls — otherwise a short screen (landscape, split screen) strands it
  const stranded = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('button')) {
      const cs = getComputedStyle(b);
      if (cs.visibility !== 'visible' || !b.offsetParent || +cs.opacity < 0.1) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1) continue;
      let scrolls = false;
      for (let n = b.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const o = getComputedStyle(n);
        if ((/(auto|scroll)/.test(o.overflowY) && n.scrollHeight > n.clientHeight + 1) ||
            (/(auto|scroll)/.test(o.overflowX) && n.scrollWidth > n.clientWidth + 1)) { scrolls = true; break; }
      }
      // off screen on purpose (a slid-away sheet): its whole box is outside the viewport
      const gone = r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth;
      if (!scrolls && !gone) out.push(`${b.id ? '#' + b.id : b.className || 'button'} "${b.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  for (const s of stranded) results.push(`[${state}] ${s} — cut off by the screen edge, and no scroll box`);
  console.log(`  ${state}: ${measured} measured, ${skipped} over-map skipped, ${failures.length} failing${stranded.length ? `, ${stranded.length} stranded` : ''}`);
}

/* put the turn cell in one ride state, deterministically */
async function rideState(page, cue, d, opts = {}) {
  await page.evaluate(([cue, d, opts]) => {
    const ns = S.navState;
    ns.off = !!opts.off; ns.cdOn = !!opts.cd; ns.cdD = d; ns.cdNear = 60;
    S.set.countUnit = opts.unit || 'm';
    S.pos = Object.assign(S.pos || {}, { speed: 8 });
    const bn = document.getElementById('banner');
    if (opts.off) { bn.textContent = 'Off track · 80 m'; bn.classList.add('on'); }
    else bn.classList.remove('on');
    setHud(cue, d, opts.dir || 1);
  }, [cue, d, opts]);
}

for (const look of LOOKS) {
  for (const [lay, vp] of Object.entries(LAYOUTS)) {
    test(`ride screens readable — ${look} · ${lay}`, async ({ page }) => {
      test.setTimeout(240_000);
      const results = [];
      const tag = `${look.replace('factory:', 'f-')}-${lay}`;
      await page.setViewportSize(vp);
      await boot(page, look === 'factory:daylight' && lay === 'portrait' ? results : null, tag);
      await applyLook(page, look);

      // ---- stopped ----
      await page.evaluate(() => creditOpen());
      await measure(page, `${tag}-idle`, results);
      await selectSweepTrack(page);
      await page.evaluate(() => { creditOpen(); updateBottomBar(); });
      await expect(page.locator('#startBar')).toBeVisible();
      await measure(page, `${tag}-stopped-track`, results);

      // dialogs and sheets reachable when stopped
      await page.evaluate(() => openBrief());
      await measure(page, `${tag}-ride-brief`, results);
      await page.evaluate(() => closeBrief(false));
      await page.evaluate(() => demoChoice());
      await measure(page, `${tag}-demo-pick`, results);
      await page.locator('#dpCancel').click();
      await openGlove(page);
      await measure(page, `${tag}-menu-stopped`, results);
      await gloveTile(page, 'Track colour').click();
      await measure(page, `${tag}-colour-pick`, results);
      await page.locator('#cpCancel').click();
      await page.evaluate(() => openTrackPicker('pick'));
      await measure(page, `${tag}-track-picker`, results);
      await page.evaluate(() => closeTrackPicker(false));
      await page.evaluate(() => { const t = S.tracks[S.sel]; openMarkPicker(t.xy[20], t.xy[21]); });
      await measure(page, `${tag}-mark-picker`, results);
      await page.locator('#markPickerClose').click();
      await page.evaluate(() => showDialog('Sweep dialog', 'A one-off explainer with <b>bold</b> words.'));
      await measure(page, `${tag}-dialog`, results);
      await page.evaluate(() => closeDialog());
      await page.evaluate(() => vargPageOpen());
      await measure(page, `${tag}-varg-page`, results);
      await page.evaluate(() => document.getElementById('vargPage').classList.remove('on'));

      // settings: every tab, advanced tabs on
      await page.evaluate(() => { S.set.showAdv = true; openPanel(); });
      for (const t of ['Account', 'Tracks', 'General', 'Nav', 'Stark', 'Keys', 'UI']) {
        await page.evaluate((t) => {
          for (const b of document.querySelectorAll('#setTabs .advOnly')) b.style.display = '';
          document.querySelector(`#setTabs button[data-t="${t}"]`).click();
        }, t);
        await measure(page, `${tag}-settings-${t}`, results);
      }
      await page.evaluate(() => closePanel());

      // ---- riding ----
      await page.evaluate(() => {
        S.set.profile = true; startNav(); stopGPS();
        const tc = document.getElementById('trainCard'); // a lesson card over the ride
        document.getElementById('trainTitle').textContent = 'Your riding screen';
        document.getElementById('trainMsg').innerHTML = 'Top bar, middle: the <b>next turn</b>.';
        document.getElementById('trainStep').textContent = '3 / 12';
        tc.classList.add('on');
      });
      await measure(page, `${tag}-ride-lesson`, results);
      await page.evaluate(() => document.getElementById('trainCard').classList.remove('on'));
      await rideState(page, { type: 'left', deg: -75, name: 'Wisemans Ferry Road' }, 1850);
      await measure(page, `${tag}-ride-pale`, results);
      await rideState(page, { type: 'right', deg: 125, name: 'Middle Ridge Rd' }, 220, { cd: true });
      await measure(page, `${tag}-ride-countdown`, results);
      await rideState(page, { type: 'left', deg: -170, onto: 'fire trail', from: 'road' }, 40, { cd: true });
      await measure(page, `${tag}-ride-near`, results);
      await rideState(page, { type: 'danger', kind: 'danger' }, 120, { cd: true, unit: 's' });
      await measure(page, `${tag}-ride-hazard-seconds`, results);
      await rideState(page, null, 0, { off: true });
      await measure(page, `${tag}-ride-offtrack`, results);
      await openGlove(page);
      await measure(page, `${tag}-menu-riding`, results);
      await closeGloveP(page);

      if (ENFORCE) expect(results, results.join('\n')).toEqual([]);
      else if (results.length) console.warn(`WARN (report-only):\n${results.join('\n')}`);
    });
  }
}
