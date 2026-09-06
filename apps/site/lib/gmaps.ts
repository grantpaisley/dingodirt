// Google Maps URL → routed GPX. A port of core/rust/google/src/maps.rs for
// the site, so DingoNav (a static app on a phone) can turn a shared
// `maps.app.goo.gl` link into a track without reaching the daemon.
//
// Design: docs/plans/nav-2026-09-06-gmaps-link-import-design.md. The URL
// only carries the ordered stops (names in the path, precise lat/lons in
// the `data=` blob); the road-following geometry lives on Google's servers,
// so the stops go to the Routes API and the returned polyline becomes a
// timestamp-free GPX — the same shape the daemon synthesizes, so a route
// imported in Plan and in nav gets the same name.
//
// Keep this in step with the Rust module. Both test suites carry the same
// URL fixtures so a drift shows up on whichever side changes.

export class GmapsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmapsError";
  }
}

/** One stop. Precise coordinates come from the `data=` blob when present. */
export type Waypoint = {
  name: string;
  /** [lat, lon] */
  coord: [number, number] | null;
};

/** A parsed `/maps/dir/` URL: ordered waypoints + Routes API travel mode. */
export type DirRequest = {
  waypoints: Waypoint[];
  travelMode: "DRIVE" | "BICYCLE" | "WALK";
};

/** Only Google's own hosts — the endpoint follows redirects, so this is
 *  checked on the pasted link and again on the resolved one. */
export function isGmapsHost(url: string): boolean {
  const rest = url.startsWith("https://")
    ? url.slice(8)
    : url.startsWith("http://")
      ? url.slice(7)
      : null;
  if (rest === null) return false;
  let host = rest.split("/")[0] ?? "";
  host = host.split("@").pop() ?? host; // no userinfo tricks
  host = host.split(":")[0] ?? host;
  return (
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "google.com" ||
    host === "www.google.com" ||
    host === "maps.google.com" ||
    host.endsWith(".google.com")
  );
}

/** Follow a share link to the full `/maps/dir/` URL. Full URLs pass
 *  straight through without a network round trip. */
export async function resolveUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (url.includes("/maps/dir/")) return url;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", redirect: "follow" });
  } catch (err) {
    throw new GmapsError(`could not resolve link: ${describe(err)}`);
  }
  return res.url || url;
}

/** Parse a full Google Maps directions URL. */
export function parseDirUrl(url: string): DirRequest {
  const after = url.split("/maps/dir/")[1];
  if (after === undefined) {
    throw new GmapsError(
      "not a Google Maps directions link (expected …/maps/dir/…)",
    );
  }

  // Path segments up to `@` (map viewport) or `data=` are the stops.
  const names: string[] = [];
  for (const seg of after.split("/")) {
    if (seg.startsWith("@") || seg.startsWith("data=")) break;
    if (!seg) continue;
    names.push(percentDecode(seg.split("?")[0] ?? seg));
  }
  if (names.length === 0) {
    throw new GmapsError("directions link has no waypoints");
  }

  // Precise stop coordinates from the data blob: `!3d<lat>!4d<lon>` pairs,
  // in stop order.
  const data = url.split("data=")[1] ?? "";
  const coords = extractCoordPairs(data);

  const modeChar = data.split("!3e")[1]?.[0];
  const travelMode: DirRequest["travelMode"] =
    modeChar === "1" ? "BICYCLE" : modeChar === "2" ? "WALK" : "DRIVE";

  const waypoints = names.map((name, i) => ({
    name,
    // A stop typed as raw coordinates ("-33.7,151.0") carries its own
    // position even without a data blob.
    coord: coords[i] ?? parseLatLng(name),
  }));

  return { waypoints, travelMode };
}

function extractCoordPairs(data: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /!3d(-?[\d.]+)!4d(-?[\d.]+)/g;
  for (const m of data.matchAll(re)) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
  }
  return out;
}

function parseLatLng(s: string): [number, number] | null {
  const parts = s.split(",");
  if (parts.length !== 2) return null;
  const a = parts[0]!.trim();
  const b = parts[1]!.trim();
  if (!/^-?\d+(\.\d+)?$/.test(a) || !/^-?\d+(\.\d+)?$/.test(b)) return null;
  return [Number(a), Number(b)];
}

function percentDecode(seg: string): string {
  const plus = seg.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/** Call the Routes API and return the route as [lat, lon] points. */
export async function computeRoute(
  req: DirRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<[number, number][]> {
  if (req.waypoints.length < 2) {
    throw new GmapsError("need at least an origin and a destination");
  }
  const wp = (w: Waypoint) =>
    w.coord
      ? { location: { latLng: { latitude: w.coord[0], longitude: w.coord[1] } } }
      : { address: w.name };
  const body = {
    origin: wp(req.waypoints[0]!),
    destination: wp(req.waypoints[req.waypoints.length - 1]!),
    intermediates: req.waypoints.slice(1, -1).map(wp),
    travelMode: req.travelMode,
    polylineQuality: "HIGH_QUALITY",
  };

  let res: Response;
  try {
    res = await fetchImpl(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "routes.polyline.encodedPolyline,routes.distanceMeters",
        },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    throw new GmapsError(`Routes API request failed: ${describe(err)}`);
  }

  let payload: RoutesPayload;
  try {
    payload = (await res.json()) as RoutesPayload;
  } catch (err) {
    throw new GmapsError(`Routes API bad response: ${describe(err)}`);
  }
  if (!res.ok) {
    const msg = payload?.error?.message ?? "unknown error";
    throw new GmapsError(`Routes API error (${res.status}): ${msg}`);
  }
  const encoded = payload?.routes?.[0]?.polyline?.encodedPolyline;
  if (typeof encoded !== "string") {
    throw new GmapsError("Routes API returned no route");
  }
  return decodePolyline(encoded);
}

type RoutesPayload = {
  error?: { message?: string };
  routes?: { polyline?: { encodedPolyline?: string } }[];
};

/** Decode a Google encoded polyline (precision 1e-5) into [lat, lon] points. */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= encoded.length) return null;
      const b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    const dlat = next();
    if (dlat === null) break;
    const dlon = next();
    if (dlon === null) break;
    lat += dlat;
    lon += dlon;
    points.push([lat * 1e-5, lon * 1e-5]);
  }
  return points;
}

/** Synthesize a timestamp-free GPX from the routed points. Metadata records
 *  the source URL and the stop names. */
export function buildRouteGpx(
  req: DirRequest,
  sourceUrl: string,
  points: readonly (readonly [number, number])[],
): string {
  const title = routeTitle(req.waypoints.map((w) => w.name));
  const desc = `Imported from Google Maps: ${sourceUrl}`;
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Dingo" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${xmlEscape(title)}</name><desc>${xmlEscape(desc)}</desc></metadata>`,
    `  <trk><name>${xmlEscape(title)}</name>`,
    "    <trkseg>",
  ];
  for (const [lat, lon] of points) {
    out.push(`      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"></trkpt>`);
  }
  out.push("    </trkseg>", "  </trk>", "</gpx>", "");
  return out.join("\n");
}

/** "A loop via B" when start == end, else "A to B". */
export function routeTitle(names: readonly string[]): string {
  if (names.length === 0) return "Google Maps route";
  if (names.length === 1) return `Google Maps route: ${names[0]}`;
  const first = names[0]!;
  const last = names[names.length - 1]!;
  if (first === last && names.length > 2) return `${first} loop via ${names[1]}`;
  return `${first} to ${last}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
