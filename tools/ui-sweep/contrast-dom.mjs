/* Rendered-contrast helpers for the sweep.
 *
 * collectTextStyles runs IN THE PAGE: for every visible text-bearing element
 * it reports the computed foreground and the effective background (ancestor
 * backgrounds alpha-composited until opaque). Ratio maths runs in Node via
 * tools/contrast.mjs — one source of truth with the static token guard.
 */
import { contrastRatio } from '../contrast.mjs';

/** Page function (serialized by Playwright — no outer-scope references).
 *  Returns [{ text, sel, fg, bg, px, bold, overCanvas }]. */
export function collectTextStyles(rootSelector) {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return [];
  const out = [];
  const parse = (c) => {
    let m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    // color-mix() computes to color(srgb r g b / a) with 0..1 channels
    m = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
    if (m) return [255 * +m[1], 255 * +m[2], 255 * +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
  };
  const composite = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [
      (top[0] * top[3] + under[0] * under[3] * (1 - top[3])) / a,
      (top[1] * top[3] + under[1] * under[3] * (1 - top[3])) / a,
      (top[2] * top[3] + under[2] * under[3] * (1 - top[3])) / a,
      a,
    ];
  };
  const hex = (rgb) =>
    '#' + rgb.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const shortSel = (el) => {
    const bits = [];
    for (let n = el; n && n !== document.body && bits.length < 3; n = n.parentElement) {
      bits.unshift(n.id ? `#${n.id}` : n.tagName.toLowerCase() +
        (n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : ''));
    }
    return bits.join(' > ');
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    if (!node.textContent.trim()) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible' || +cs.opacity < 0.1) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;

    let fg = parse(cs.color);
    if (!fg || fg[3] < 0.1) continue;

    // climb for the effective background
    let bg = [0, 0, 0, 0];
    let overCanvas = false;
    for (let n = el; n; n = n.parentElement) {
      const ncs = getComputedStyle(n);
      const nb = parse(ncs.backgroundColor);
      if (nb && nb[3] > 0) bg = composite(bg, nb);
      if (bg[3] >= 0.999) break;
      if (n.querySelector?.(':scope > canvas') || n.tagName === 'CANVAS') overCanvas = true;
    }
    if (bg[3] < 0.999) {
      // never reached opaque — text sits over the map canvas or the page
      // default; measurable only by pixels, so report as over-canvas.
      overCanvas = true;
    }
    // fg with alpha composites over the resolved bg before measuring
    const fgFlat = fg[3] < 1 && bg[3] >= 0.999 ? composite(fg, bg) : fg;

    out.push({
      text: node.textContent.trim().slice(0, 40),
      sel: shortSel(el),
      fg: hex(fgFlat),
      bg: bg[3] >= 0.999 ? hex(bg) : null,
      px: parseFloat(cs.fontSize),
      bold: +cs.fontWeight >= 600,
      overCanvas,
    });
  }
  return out;
}

/** Node side: turn collected samples into failures. WCAG 1.4.3: 3:1 for
 *  large text (>=24px, or >=18.66px bold), else 4.5:1. */
export function contrastFailures(samples, state) {
  const failures = [];
  let skipped = 0;
  for (const s of samples) {
    if (s.overCanvas || !s.bg) { skipped++; continue; }
    const large = s.px >= 24 || (s.px >= 18.66 && s.bold);
    const need = large ? 3 : 4.5;
    const ratio = contrastRatio(s.fg, s.bg);
    if (ratio < need) {
      failures.push(
        `[${state}] ${s.sel} "${s.text}" — ${s.fg} on ${s.bg} = ${ratio.toFixed(2)}:1 (needs ${need}:1)`);
    }
  }
  return { failures, skipped, measured: samples.length - skipped };
}
