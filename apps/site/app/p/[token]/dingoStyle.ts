// The shared Dingo basemap for the public plan page — the same
// core/basemap layer lineage Nav/Plan/Studio render, in its factory look
// (no scheme store on the site). Assets come from /public/basemap and
// lib/core, both copied from core/ by scripts/sync-core.mjs; tiles come
// off the shared R2 archive via the pmtiles protocol.
import { Protocol } from "pmtiles";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import {
  applyBaseOverrides,
  basePaintOverrides,
} from "@/lib/core/applier-nav.js";
import { applyDetailBias } from "@/lib/core/detail.js";

export type DetailLevel = "populated" | "regional" | "outback";

const TILES_URL = "https://tiles.dingodirt.com/basemap-au.pmtiles";

// Register the pmtiles protocol once, on the vendored maplibre build the
// page loads at runtime (window.maplibregl — see PlanView's loadMaplibre).
let protocolReady = false;
export function ensurePmtilesProtocol(ml: {
  addProtocol: (scheme: string, fn: unknown) => void;
}): void {
  if (protocolReady) return;
  ml.addProtocol("pmtiles", new Protocol().tile as unknown);
  protocolReady = true;
}

let layersPromise: Promise<LayerSpecification[]> | null = null;
function fetchLayers(): Promise<LayerSpecification[]> {
  // Dark flavour — matches the site's ink theme.
  layersPromise ??= fetch("/basemap/layers.json").then((r) => {
    if (!r.ok) {
      layersPromise = null;
      throw new Error(`basemap layers HTTP ${r.status}`);
    }
    return r.json() as Promise<LayerSpecification[]>;
  });
  return layersPromise;
}

/** Build the full MapLibre style. Throws when the layer file can't load —
 *  the caller falls back to a raster basemap. */
export async function buildDingoStyle(
  detail: DetailLevel,
): Promise<StyleSpecification> {
  const base = await fetchLayers();
  // Factory scheme: the applier's own defaults, exactly like Nav with no
  // scheme installed.
  let layers = applyBaseOverrides(
    base,
    basePaintOverrides({}),
  ) as LayerSpecification[];
  layers = applyDetailBias(layers, detail) as LayerSpecification[];
  const assetBase = `${location.origin}/basemap/`;
  return {
    version: 8,
    glyphs: `${assetBase}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assetBase}sprites/dark`,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${TILES_URL}`,
        attribution: "© OpenStreetMap, Protomaps",
      },
    },
    layers,
  };
}
