// Road closures for the public plan page — a TS port of the daemon's
// closures.rs (docs/plans/site-2026-08-09-plan-page-parity.md).
//
// Two upstreams, both free and keyless:
// - SA DIT Outback Road Warnings (ArcGIS GeoJSON): served whole — it IS the
//   region of interest. Statuses: closed / 4wd / warning.
// - VicTraffic aggregate disruptions (~20k records, NSW + VIC): hard closures
//   only, currently active, planned roadworks dropped. The daemon filters by
//   distance to the ride library; the site has no library, so the caller
//   passes the plan's padded bounding box (?bbox=minLon,minLat,maxLon,maxLat)
//   and the filter is bbox containment of each closure's sample points.
//
// Closures are advisory: a "closed" road is often bike-passable, so the
// payload keeps the full source text and a per-closure source URL.

import { NextRequest, NextResponse } from "next/server";

// The VicTraffic pull is ~29 MB across ~11 pages — allow the slow path.
export const maxDuration = 60;

const SA_URL =
  "https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/FNRR2/MapServer/0/query?where=STATUS%20%3E%3D%202&outFields=OBJECTID,ROAD_SECTION,STATUS,DESCRIPTION,COMMENTS,AREA_NAME&f=geojson";
const VICTRAFFIC_URL = "https://api.traffic.transport.vic.gov.au/disruptions";

// Upstream cache TTL — closures change on flood timescales, not minutes.
const REVALIDATE = 15 * 60;

// VicTraffic's CloudFront 403s non-browser agents.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Dingo/closures";

type Json = Record<string, unknown>;

interface Feature {
  type: "Feature";
  geometry: Json;
  properties: Json;
  /** Sample points for the bbox filter (not serialised). */
  samples?: [number, number][];
}

// ---------------------------------------------------------------------------
// VicTraffic geometry — encoded polylines, precision 5, LON-first pairs
// ---------------------------------------------------------------------------

function decodePolyline(s: string): [number, number][] {
  const coords: [number, number][] = [];
  let lon = 0;
  let lat = 0;
  let i = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= s.length) return null;
      const b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  for (;;) {
    const dlon = next();
    const dlat = next();
    if (dlon === null || dlat === null) break;
    lon += dlon;
    lat += dlat;
    coords.push([lon / 1e5, lat / 1e5]);
  }
  return coords;
}

/** NSW records carry HTML in their descriptions — flatten to plain text. */
function stripHtml(s: string): string {
  const text = s
    .replace(/<[^>]*>/g, "\n")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Upstream fetches (Next data cache handles the 15-min reuse)
// ---------------------------------------------------------------------------

async function fetchSa(): Promise<Feature[]> {
  const res = await fetch(SA_URL, {
    headers: { "user-agent": UA },
    next: { revalidate: REVALIDATE },
  });
  if (!res.ok) throw new Error(`SA feed HTTP ${res.status}`);
  const fc = (await res.json()) as Json;
  // ArcGIS reports errors as 200 + {"error": …}
  const features = fc.features;
  if (fc.error || !Array.isArray(features)) {
    throw new Error("SA feed returned no features");
  }
  const out: Feature[] = [];
  for (const f of features as Json[]) {
    const p = (f.properties ?? {}) as Json;
    const code = typeof p.STATUS === "number" ? p.STATUS : 0;
    const status =
      code === 5 ? "closed" : code === 3 || code === 4 ? "4wd" : code === 2 ? "warning" : null;
    if (!status) continue;
    out.push({
      type: "Feature",
      geometry: f.geometry as Json,
      properties: {
        src: "SA",
        id: `sa-${p.OBJECTID ?? 0}`,
        name: (p.ROAD_SECTION as string) || "Unnamed road",
        status,
        detail: ((p.COMMENTS as string) ?? "").trim(),
        kind: (p.DESCRIPTION as string) ?? "",
        area: (p.AREA_NAME as string) ?? "",
        url: "https://dit.sa.gov.au/outbackroads",
      },
    });
  }
  return out;
}

/** Every page of the VicTraffic aggregate, flattened to the item list. */
async function fetchVictraffic(): Promise<Json[]> {
  const items: Json[] = [];
  let cursor = "0";
  for (let page = 0; page < 20; page++) {
    const url = `${VICTRAFFIC_URL}?baselineId=0&lastSeenId=0&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) throw new Error(`VicTraffic HTTP ${res.status}`);
    const val = (await res.json()) as Json;
    const pageItems = (val.state as Json | undefined)?.items;
    if (!pageItems || typeof pageItems !== "object") {
      throw new Error("VicTraffic page missing state.items");
    }
    for (const v of Object.values(pageItems as Record<string, Json>)) {
      if (v && typeof v === "object" && v.data) items.push(v.data as Json);
    }
    const meta = (val.meta ?? {}) as Json;
    const total = parseInt(String(meta.total ?? "0"), 10) || 0;
    const next = typeof meta.cursor === "string" ? meta.cursor : "";
    if (!next || items.length >= total) break;
    cursor = next;
  }
  return items;
}

// ---------------------------------------------------------------------------
// VicTraffic filter: hard closures, active now, deduped
// ---------------------------------------------------------------------------

function isActive(data: Json): boolean {
  if (((data.status as string) ?? "Active") !== "Active") return false;
  const now = Date.now();
  const parse = (k: string): number | null => {
    const s = data[k];
    if (typeof s !== "string") return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  };
  // Unparseable/missing bounds don't hide a closure — advisory layer.
  const start = parse("start");
  if (start !== null && start > now) return false;
  const end = parse("end");
  if (end !== null && end < now) return false;
  return true;
}

function victrafficFeatures(items: Json[]): Feature[] {
  const seen = new Set<string>();
  const out: Feature[] = [];
  for (const data of items) {
    const impact = (data.impactType as string) ?? "";
    if (impact !== "Closures" && impact !== "Road Closed") continue;
    const source = (data.source as string) ?? "";
    // SA records come from the DIT feed; tow trucks aren't closures.
    if (source === "SA" || source === "TowAllocation") continue;
    // Planned roadworks closures are metro maintenance noise. Condition-based
    // closures stay: seasonal track closures, flood, fire, landslip.
    if (data.kind === "Planned" && data.eventType === "Roadworks") continue;
    if (!isActive(data)) continue;
    const id = (data.id as string) ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const lines = ((data.geolinesSet as unknown[]) ?? [])
      .filter((g): g is string => typeof g === "string")
      .map(decodePolyline)
      .filter((l) => l.length >= 2);
    const loc = data.location as unknown[] | undefined;
    const location: [number, number] | null =
      Array.isArray(loc) && typeof loc[0] === "number" && typeof loc[1] === "number"
        ? [loc[0], loc[1]]
        : null;

    // Sample points: the anchor plus each line's ends + middle — a 300 km
    // closure whose far end brushes the plan area still shows.
    const samples: [number, number][] = location ? [location] : [];
    for (const l of lines) {
      samples.push(l[0], l[Math.floor(l.length / 2)], l[l.length - 1]);
    }
    if (!samples.length) continue;

    const geometry: Json = lines.length
      ? { type: "MultiLineString", coordinates: lines }
      : { type: "Point", coordinates: location };
    const name =
      ((data.closedRoadName as string) || (data.from as string) || "").trim() ||
      "Road closure";
    const detail = stripHtml(
      [(data.eventDueTo as string) ?? "", (data.description as string) ?? ""]
        .filter((s) => s.trim())
        .join("\n"),
    );
    // The upstream often ships one record per direction (same road, same
    // text) and the seasonal feed repeats tracks outright.
    const dupeKey = `${source}|${name}|${detail}`;
    if (seen.has(dupeKey)) continue;
    seen.add(dupeKey);

    out.push({
      type: "Feature",
      geometry,
      properties: {
        src: source === "NSW" ? "NSW" : "VIC",
        id,
        name,
        status: "closed",
        detail,
        kind: `${(data.kind as string) ?? ""} ${(data.eventType as string) ?? ""}`.trim(),
        updated: data.updated,
        url: `https://traffic.transport.vic.gov.au/disruptions/${id}`,
      },
      samples,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /api/closures?bbox=minLon,minLat,maxLon,maxLat
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const bboxParam = req.nextUrl.searchParams.get("bbox");
  const bbox = bboxParam?.split(",").map(Number);
  const hasBbox =
    !!bbox && bbox.length === 4 && bbox.every((n) => Number.isFinite(n));

  const features: Json[] = [];
  const warnings: string[] = [];

  await Promise.allSettled([
    fetchSa().then(
      (fs) => {
        for (const f of fs) features.push({ ...f, samples: undefined });
      },
      (e) => warnings.push(`SA outback feed unavailable: ${e.message ?? e}`),
    ),
    fetchVictraffic().then(
      (items) => {
        for (const f of victrafficFeatures(items)) {
          const near =
            !hasBbox ||
            f.samples!.some(
              ([lon, lat]) =>
                lon >= bbox![0] && lon <= bbox![2] && lat >= bbox![1] && lat <= bbox![3],
            );
          if (near) features.push({ ...f, samples: undefined });
        }
      },
      (e) => warnings.push(`NSW/VIC feed unavailable: ${e.message ?? e}`),
    ),
  ]);

  return NextResponse.json(
    { type: "FeatureCollection", features, warnings },
    {
      headers: {
        // CDN-cache the assembled payload; browsers revalidate.
        "cache-control": "public, s-maxage=900, stale-while-revalidate=3600",
      },
    },
  );
}
