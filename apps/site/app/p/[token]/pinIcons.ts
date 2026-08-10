// Map pin badges for the plan share page — the same look the Plan app draws
// from lucide-react in apps/plan/src/components/Map/poiIcons.ts: a filled
// category-coloured disc with a white rim and a white lucide glyph.
//
// The site is a standalone package with no lucide-react dependency, so the
// glyph geometry is vendored below (lucide v1.23.0, ISC) as the icons'
// own node arrays, and drawn straight onto a canvas with Path2D — no React,
// no SVG rasterising, no async image loads. Keep the entries in step with
// POI_CATEGORY_META in the Plan app; the colours are shared by hand.

/** Lucide node: the element tag plus its attributes, on a 24×24 viewBox. */
type GlyphNode = [string, Record<string, string>];

const GLYPHS: Record<string, GlyphNode[]> = {
  fuel: [
    ["path", { d: "M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5" }],
    ["path", { d: "M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16" }],
    ["path", { d: "M2 21h13" }],
    ["path", { d: "M3 9h11" }],
  ],
  tent: [
    ["path", { d: "M3.5 21 14 3" }],
    ["path", { d: "M20.5 21 10 3" }],
    ["path", { d: "M15.5 21 12 15l-3.5 6" }],
    ["path", { d: "M2 21h20" }],
  ],
  droplets: [
    ["path", { d: "M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z" }],
    ["path", { d: "M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97" }],
  ],
  beer: [
    ["path", { d: "M17 11h1a3 3 0 0 1 0 6h-1" }],
    ["path", { d: "M9 12v6" }],
    ["path", { d: "M13 12v6" }],
    ["path", { d: "M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z" }],
    ["path", { d: "M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" }],
  ],
  bed: [
    ["path", { d: "M2 4v16" }],
    ["path", { d: "M2 8h18a2 2 0 0 1 2 2v10" }],
    ["path", { d: "M2 17h20" }],
    ["path", { d: "M6 8v9" }],
  ],
  cross: [
    ["path", { d: "M4 9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h4a1 1 0 0 1 1 1v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a1 1 0 0 1 1-1h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-4a1 1 0 0 1-1-1V4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4a1 1 0 0 1-1 1z" }],
  ],
  "triangle-alert": [
    ["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }],
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }],
  ],
  info: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }],
  ],
  mountain: [["path", { d: "m8 3 4 8 5-5 5 15H2L8 3z" }]],
  camera: [
    ["path", { d: "M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" }],
    ["circle", { cx: "12", cy: "13", r: "3" }],
  ],
  "map-pin": [
    ["path", { d: "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" }],
    ["circle", { cx: "12", cy: "10", r: "3" }],
  ],
  construction: [
    ["rect", { x: "2", y: "6", width: "20", height: "8", rx: "1" }],
    ["path", { d: "M17 14v7" }],
    ["path", { d: "M7 14v7" }],
    ["path", { d: "M17 3v3" }],
    ["path", { d: "M7 3v3" }],
    ["path", { d: "M10 14 2.3 6.3" }],
    ["path", { d: "m14 6 7.7 7.7" }],
    ["path", { d: "m8 6 8 8" }],
  ],
  fence: [
    ["path", { d: "M4 3 2 5v15c0 .6.4 1 1 1h2c.6 0 1-.4 1-1V5Z" }],
    ["path", { d: "M6 8h4" }],
    ["path", { d: "M6 18h4" }],
    ["path", { d: "m12 3-2 2v15c0 .6.4 1 1 1h2c.6 0 1-.4 1-1V5Z" }],
    ["path", { d: "M14 8h4" }],
    ["path", { d: "M14 18h4" }],
    ["path", { d: "m20 3-2 2v15c0 .6.4 1 1 1h2c.6 0 1-.4 1-1V5Z" }],
  ],
  eye: [
    ["path", { d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  waves: [
    ["path", { d: "M2 12q2.5 2 5 0t5 0 5 0 5 0" }],
    ["path", { d: "M2 19q2.5 2 5 0t5 0 5 0 5 0" }],
    ["path", { d: "M2 5q2.5 2 5 0t5 0 5 0 5 0" }],
  ],
};

export interface PinCategoryMeta {
  label: string;
  /** Badge colour, shared with Plan's POI_CATEGORY_META. */
  color: string;
  /** Key into GLYPHS — the lucide icon Plan draws for this category. */
  glyph: keyof typeof GLYPHS;
  /**
   * Collision priority: maplibre keeps the LOWER sort key when two pins
   * overlap, so fuel and camps survive a crowded corridor and generic pins
   * drop out first. Mirrors Plan's declutter priority.
   */
  priority: number;
}

/**
 * POI categories (the daemon's `pois.category` enum) plus the extra
 * categories rider-placed marks need. Everything on the map — POIs and
 * marks alike — resolves to one of these.
 */
export const PIN_CATEGORIES: Record<string, PinCategoryMeta> = {
  fuel: { label: "Fuel", color: "#e67e22", glyph: "fuel", priority: 0 },
  camp: { label: "Camping", color: "#2e9e4f", glyph: "tent", priority: 1 },
  water: { label: "Water", color: "#2f8fd6", glyph: "droplets", priority: 2 },
  food: { label: "Food & drink", color: "#d65a8c", glyph: "beer", priority: 3 },
  lodging: { label: "Lodging", color: "#8e6ae0", glyph: "bed", priority: 4 },
  medical: { label: "Medical", color: "#d64545", glyph: "cross", priority: 5 },
  hazard: { label: "Hazard", color: "#e0b428", glyph: "triangle-alert", priority: 6 },
  info: { label: "Info", color: "#6b7f95", glyph: "info", priority: 7 },
  summit: { label: "Summit", color: "#7a5c3e", glyph: "mountain", priority: 8 },
  scenic: { label: "Scenic", color: "#3aa6a0", glyph: "camera", priority: 9 },
  poi: { label: "Other POI", color: "#8a8a8a", glyph: "map-pin", priority: 10 },
  // Mark-only categories — kinds a rider can drop in DingoNav that have no
  // POI equivalent. Colours stay in the Plan palette so one map reads as one
  // icon set; the glyphs are the ones Nav shows for those kinds.
  creek: { label: "Creek", color: "#2f8fd6", glyph: "waves", priority: 2 },
  obstacle: { label: "Obstacle", color: "#e0b428", glyph: "construction", priority: 6 },
  gate: { label: "Gate", color: "#8a8a8a", glyph: "fence", priority: 7 },
  lookout: { label: "Lookout", color: "#3aa6a0", glyph: "eye", priority: 9 },
};

export const pinMeta = (category?: string | null): PinCategoryMeta =>
  PIN_CATEGORIES[category ?? "poi"] ?? PIN_CATEGORIES.poi;

/** Mark kinds that are not category names in their own right. */
const MARK_KIND_ALIASES: Record<string, string> = {
  pub: "food",
  danger: "hazard",
};

/**
 * A mark's badge category. Marks published before the daemon carried `kind`
 * only have a display name ("Pub / food", or the bare kind slug on the
 * oldest docs), so the name is the fallback — those plans keep their pins
 * instead of all falling back to a grey dot.
 */
export function markCategory(kind?: string | null, name?: string | null): string {
  const fromKind = kind?.trim().toLowerCase();
  if (fromKind) {
    const cat = MARK_KIND_ALIASES[fromKind] ?? fromKind;
    if (PIN_CATEGORIES[cat]) return cat;
  }
  const fromName = name?.trim().toLowerCase();
  if (fromName) {
    if (fromName.startsWith("pub")) return "food";
    if (fromName.startsWith("danger")) return "hazard";
    const cat = fromName.split(" ")[0];
    if (PIN_CATEGORIES[cat]) return cat;
  }
  return "poi";
}

// Badge geometry, in device pixels at 2× — the same proportions Plan uses
// (a 64 px cell with a 36 px glyph), scaled to a lighter 24 CSS px pin.
const CELL = 48;
const GLYPH = 27;
const RIM = 2.25;
/** Retina factor baked into CELL; maplibre and <img> both halve it. */
export const PIN_PIXEL_RATIO = 2;

function drawGlyph(ctx: CanvasRenderingContext2D, nodes: GlyphNode[]) {
  for (const [tag, a] of nodes) {
    ctx.beginPath();
    if (tag === "path") {
      ctx.stroke(new Path2D(a.d));
      continue;
    }
    if (tag === "circle") {
      ctx.arc(+a.cx, +a.cy, +a.r, 0, Math.PI * 2);
    } else if (tag === "rect") {
      ctx.roundRect(+a.x, +a.y, +a.width, +a.height, +(a.rx ?? 0));
    }
    ctx.stroke();
  }
}

/** One badge, drawn at 2× — a coloured disc, white rim, white glyph. */
export function drawPin(category: string): HTMLCanvasElement {
  const meta = pinMeta(category);
  const canvas = document.createElement("canvas");
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext("2d")!;
  const c = CELL / 2;

  ctx.beginPath();
  ctx.arc(c, c, c - RIM - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = meta.color;
  ctx.fill();
  ctx.lineWidth = RIM;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.stroke();

  ctx.save();
  ctx.translate(c - GLYPH / 2, c - GLYPH / 2);
  ctx.scale(GLYPH / 24, GLYPH / 24);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.25;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawGlyph(ctx, GLYPHS[meta.glyph]);
  ctx.restore();

  return canvas;
}

const urlCache = new Map<string, string>();

/** Cached PNG data URL of a badge, for the list rows and cards. */
export function pinDataUrl(category: string): string {
  const key = pinMeta(category).glyph + pinMeta(category).color;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const url = drawPin(category).toDataURL("image/png");
  urlCache.set(key, url);
  return url;
}

/** maplibre image id for a category, e.g. `pin-fuel`. */
export const pinImageId = (category: string) => `pin-${category}`;

/**
 * Register every badge with the map's sprite store. Call once the style has
 * loaded and before any symbol layer references `pin-*`.
 */
export function addPinImages(map: {
  hasImage(id: string): boolean;
  addImage(id: string, image: ImageData, opts?: { pixelRatio?: number }): void;
}) {
  for (const category of Object.keys(PIN_CATEGORIES)) {
    const id = pinImageId(category);
    if (map.hasImage(id)) continue;
    const ctx = drawPin(category).getContext("2d")!;
    map.addImage(id, ctx.getImageData(0, 0, CELL, CELL), {
      pixelRatio: PIN_PIXEL_RATIO,
    });
  }
}
