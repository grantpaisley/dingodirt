/* WCAG 2.1 contrast maths + tiny CSS custom-property parsing.
 *
 * Pure library, no I/O — consumed by tests/contrast.test.mjs (Stage 1 of the
 * merge-gate readability checks) and later by the rendered UI sweep. Zero
 * dependencies by design: the repo root and Nav/Studio stay dependency-free.
 */

/** #rgb, #rrggbb or #rrggbbaa → {r,g,b (0-255), a (0-1)}. Throws on anything else. */
export function hexToRgba(hex) {
  if (typeof hex !== 'string') throw new Error(`not a colour string: ${hex}`);
  const m = hex.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

/** Alpha-composite fg over an (assumed opaque) bg. Returns opaque {r,g,b}. */
export function compositeOver(fg, bg) {
  const a = fg.a ?? 1;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** WCAG 2.1 relative luminance of an opaque {r,g,b} (0-255 channels). */
export function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colours. A translucent fg is composited
 *  over the bg first; a translucent bg is treated as opaque (its alpha channel
 *  is over an unknown surface — usually the map — so we measure the plate colour
 *  itself). */
export function contrastRatio(fgHex, bgHex) {
  const bg = hexToRgba(bgHex);
  const fg = compositeOver(hexToRgba(fgHex), bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Extract the `--name: value` declarations of the first flat `selector { ... }`
 *  block in cssText into a Map. Comments are stripped first. The selector must
 *  be followed (bar whitespace) by `{`, so asking for `:root` will not match
 *  `:root[data-mode="light"]`, and `body.daymode #panel` will not match
 *  `body.daymode #panel .btn`. Throws if the selector is absent — a refactor
 *  that renames a block must break this loudly, not silently skip its pairs. */
export function parseCssVarBlock(cssText, selector) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  let from = 0;
  for (;;) {
    const at = css.indexOf(selector, from);
    if (at === -1) throw new Error(`CSS block not found: "${selector}"`);
    from = at + selector.length;
    const rest = css.slice(from);
    if (!/^\s*\{/.test(rest)) continue; // e.g. `:root[` or `#panel .btn`
    const open = css.indexOf('{', from);
    const close = css.indexOf('}', open); // target blocks are flat — no nesting
    if (close === -1) throw new Error(`unclosed block for "${selector}"`);
    const body = css.slice(open + 1, close);
    const vars = new Map();
    for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) {
      vars.set(`--${m[1]}`, m[2].trim());
    }
    return vars;
  }
}

/** Resolve `var(--x)` references inside a Map's values to a fixpoint.
 *  Throws on unknown references and on cycles. */
export function resolveVarRefs(map) {
  const out = new Map(map);
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const [k, v] of out) {
      const next = v.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, ref) => {
        if (!out.has(ref)) throw new Error(`${k} references unknown ${ref}`);
        return out.get(ref);
      });
      if (next !== v) { out.set(k, next); changed = true; }
    }
    if (!changed) return out;
  }
  throw new Error('var() reference cycle');
}
