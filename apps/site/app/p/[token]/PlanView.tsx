"use client";

// Planning-mode share page: all candidate tracks on one interactive map,
// with Yes/Maybe/No voting per track and mark
// (docs/plans/2026-08-07-planning-mode-design.md). Identity is a
// self-reported name in localStorage; the share link is the access control.
//
// Parity pass (docs/plans/site-2026-08-09-plan-page-parity.md): additive
// click selection, original track colours, POI pins + road closures
// overlays, Dingo vector basemap with the City/Regional/Outback detail
// toggle.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as maplibreNs from "maplibre-gl";
import {
  buildDingoStyle,
  ensurePmtilesProtocol,
  type DetailLevel,
} from "./dingoStyle";

// The npm maplibre build spawns its worker via module URLs the bundler
// rewrites into 404s (map silently never renders), so like Nav and Studio
// this page runs the vendored standalone build: script + css from
// /public/vendor, worker self-contained. npm package stays for types only.
type MaplibreNS = typeof maplibreNs;
declare global {
  interface Window {
    maplibregl?: MaplibreNS;
  }
}
let maplibreLoading: Promise<MaplibreNS> | null = null;
function loadMaplibre(): Promise<MaplibreNS> {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  maplibreLoading ??= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/vendor/maplibre-gl.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "/vendor/maplibre-gl.js";
    script.onload = () => resolve(window.maplibregl!);
    script.onerror = () => {
      maplibreLoading = null;
      reject(new Error("maplibre failed to load"));
    };
    document.head.appendChild(script);
  });
  return maplibreLoading;
}

export interface PlanTrack {
  id: string;
  name: string;
  km?: number;
  grade?: string | null;
  mode?: string | null;
  kind?: string | null;
  region?: string | null;
  state?: string | null;
  description?: string | null;
  /** Original display colour (GOAT GPX imports) — hex, usually. */
  color?: string | null;
  collection?: string | null;
  /** LineString, or MultiLineString when privacy trimming split the line. */
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: [number, number][] | [number, number][][];
  };
}

export interface PlanMark {
  id: string;
  name: string;
  icon?: string | null;
  lon: number;
  lat: number;
}

export interface PlanPoi {
  id: string;
  lon: number;
  lat: number;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  collection?: string | null;
}

export interface PlanDoc {
  name: string;
  description?: string;
  tracks: PlanTrack[];
  marks?: PlanMark[];
  pois?: PlanPoi[];
}

interface ItemFeedback {
  votes: Record<string, string>;
  comments: { who: string; text: string; at: string }[];
}
type Feedback = Record<string, ItemFeedback>;

/** Flat coordinate list for bounds math, either geometry flavour. */
function coordsOf(g: PlanTrack["geometry"]): [number, number][] {
  return (
    g.type === "MultiLineString"
      ? (g.coordinates as [number, number][][]).flat()
      : (g.coordinates as [number, number][])
  );
}

/** A stored track colour → CSS. Import colours are hex, sometimes bare. */
function cssColor(c?: string | null): string | null {
  if (!c) return null;
  const t = c.trim();
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`;
  return t;
}

// Raster basemap sources; the Dingo vector style is built separately
// (dingoStyle.ts). All free public sources — no API key on this page.
const RASTER_BASEMAPS: Record<
  string,
  { tiles: string[]; attribution: string; maxzoom: number }
> = {
  topo: {
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap",
    maxzoom: 19,
  },
  satellite: {
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Esri, Maxar, Earthstar Geographics",
    maxzoom: 18,
  },
  outdoor: {
    tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)",
    maxzoom: 17,
  },
};
type BasemapId = "dingo" | keyof typeof RASTER_BASEMAPS;
const BASEMAP_LABELS: Record<BasemapId, string> = {
  dingo: "Dingo",
  topo: "Topo",
  satellite: "Satellite",
  outdoor: "Outdoor",
};
const DETAIL_LABELS: Record<DetailLevel, string> = {
  populated: "City",
  regional: "Regional",
  outback: "Outback",
};

const TRACK_COLOR = "#e07a3f"; // clay-ish, matches the site accent
const VERDICT_COLORS: Record<string, string> = {
  yes: "#57a557",
  maybe: "#c9a227",
  no: "#8a4a42",
  none: "#8a8177",
};

// POI categories — colours/labels/emoji mirror Plan's poiIcons.ts.
const POI_META: Record<string, { label: string; color: string; emoji: string }> = {
  fuel: { label: "Fuel", color: "#e67e22", emoji: "⛽" },
  camp: { label: "Camping", color: "#2e9e4f", emoji: "⛺" },
  water: { label: "Water", color: "#2f8fd6", emoji: "💧" },
  food: { label: "Food & drink", color: "#d65a8c", emoji: "🍺" },
  lodging: { label: "Lodging", color: "#8e6ae0", emoji: "🛏️" },
  medical: { label: "Medical", color: "#d64545", emoji: "🚑" },
  hazard: { label: "Hazard", color: "#e0b428", emoji: "⚠️" },
  info: { label: "Info", color: "#6b7f95", emoji: "ℹ️" },
  summit: { label: "Summit", color: "#7a5c3e", emoji: "⛰️" },
  scenic: { label: "Scenic", color: "#3aa6a0", emoji: "📷" },
  poi: { label: "Other POI", color: "#8a8a8a", emoji: "📍" },
};
const poiMeta = (cat?: string | null) => POI_META[cat ?? "poi"] ?? POI_META.poi;

// Closure status colours — mirror Plan's CLOSURE_COLORS.
const CLOSURE_COLORS: Record<string, string> = {
  closed: "#e5484d",
  warning: "#f5a524",
  "4wd": "#ff8a3d",
};
interface ClosureProps {
  src: string;
  id: string;
  name: string;
  status: "closed" | "warning" | "4wd";
  detail: string;
  kind: string;
  area?: string;
  updated?: string;
  url: string;
}

// ---- verdicts: majority among voters; no wins ties; yes >= maybe = yes ----
function tally(f?: ItemFeedback) {
  const c = { yes: 0, maybe: 0, no: 0 };
  for (const v of Object.values(f?.votes ?? {}))
    if (v in c) c[v as keyof typeof c]++;
  return c;
}
function verdict(f?: ItemFeedback): "yes" | "maybe" | "no" | "none" {
  const c = tally(f);
  const total = c.yes + c.maybe + c.no;
  if (!total) return "none";
  if (c.no >= Math.max(c.yes, c.maybe)) return "no";
  return c.yes >= c.maybe ? "yes" : "maybe";
}
function score(f?: ItemFeedback) {
  const c = tally(f);
  return c.yes * 2 + c.maybe - c.no * 2;
}

const NAME_KEY = "ddt-plan-name";

type SortMode = "wanted" | "name" | "km" | "unvoted";
type ColorBy = "original" | "votes";

export default function PlanView({
  doc,
  token,
}: {
  doc: PlanDoc;
  token: string;
}) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibreNs.Map | null>(null);
  // Additive selection: a click adds a track, a second click removes it,
  // Escape clears the lot (parity with Plan's map behaviour).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedRef = useRef<string[]>([]);
  const [basemap, setBasemap] = useState<BasemapId>("dingo");
  const [detail, setDetail] = useState<DetailLevel>("outback");
  const [colorBy, setColorBy] = useState<ColorBy>("original");
  const colorByRef = useRef<ColorBy>("original");
  const [showPois, setShowPois] = useState(true);
  const [showClosures, setShowClosures] = useState(true);
  const [poiCard, setPoiCard] = useState<{ x: number; y: number; poi: PlanPoi } | null>(null);
  const [closureCard, setClosureCard] = useState<{ x: number; y: number; c: ClosureProps } | null>(null);
  const [closures, setClosures] = useState<GeoJSON.FeatureCollection | null>(null);
  const closuresRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({});
  const feedbackRef = useRef<Feedback>({});
  const [me, setMe] = useState<string | null>(null);
  const [askName, setAskName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [postError, setPostError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("wanted");
  // Stable row order: recomputed only when the sort mode changes or votes
  // first arrive — never on a vote, so rows don't jump under the cursor.
  const [order, setOrder] = useState<string[]>(() =>
    doc.tracks.map((t) => t.id),
  );
  const orderedOnce = useRef(false);
  feedbackRef.current = feedback;
  selectedRef.current = selectedIds;
  colorByRef.current = colorBy;
  closuresRef.current = closures;

  useEffect(() => {
    setMe(localStorage.getItem(NAME_KEY));
  }, []);

  const fb = useCallback(
    (type: "track" | "mark", id: string) => feedback[`${type}:${id}`],
    [feedback],
  );

  // ---- server sync ----
  const applyItems = useCallback((items: Feedback) => {
    setFeedback(items);
    const map = mapRef.current;
    const src = map?.getSource("tracks") as maplibreNs.GeoJSONSource | undefined;
    if (src) src.setData(buildFC(items) as GeoJSON.FeatureCollection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/packs/${token}/feedback`);
      if (!res.ok) return;
      const body = await res.json();
      if (body?.items) applyItems(body.items);
    } catch {
      /* transient — next poll retries */
    }
  }, [token, applyItems]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30_000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const post = useCallback(
    async (
      itemType: "track" | "mark",
      itemId: string,
      payload: { vote?: string; comment?: string },
    ) => {
      const name = localStorage.getItem(NAME_KEY);
      if (!name) {
        setAskName(true);
        return;
      }
      setPostError(null);
      try {
        const res = await fetch(`/api/packs/${token}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemType, itemId, name, ...payload }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setPostError(body?.error ?? "Vote failed — try again.");
          return;
        }
        if (body?.items) applyItems(body.items);
      } catch {
        setPostError("Vote failed — check your connection.");
      }
    },
    [token, applyItems],
  );

  // ---- ordering ----
  const sortedIds = useCallback(
    (mode: SortMode, f: Feedback) => {
      const t = [...doc.tracks];
      const item = (id: string) => f[`track:${id}`];
      if (mode === "name") t.sort((a, b) => a.name.localeCompare(b.name));
      else if (mode === "km") t.sort((a, b) => (b.km ?? 0) - (a.km ?? 0));
      else if (mode === "unvoted") {
        const meName = localStorage.getItem(NAME_KEY);
        const mine = (id: string) =>
          meName && item(id)?.votes[meName] ? 1 : 0;
        t.sort((a, b) => mine(a.id) - mine(b.id));
      } else t.sort((a, b) => score(item(b.id)) - score(item(a.id)));
      return t.map((x) => x.id);
    },
    [doc.tracks],
  );

  const pickSort = (mode: SortMode) => {
    setSort(mode);
    setOrder(sortedIds(mode, feedbackRef.current));
  };

  // First feedback load: apply the default sort once, with votes known.
  useEffect(() => {
    if (orderedOnce.current || !Object.keys(feedback).length) return;
    orderedOnce.current = true;
    setOrder(sortedIds(sort, feedback));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedback]);

  const tracksInOrder = useMemo(() => {
    const byId = new Map(doc.tracks.map((t) => [t.id, t]));
    return order
      .map((id) => byId.get(id))
      .filter((t): t is PlanTrack => !!t);
  }, [doc.tracks, order]);

  // ---- rollup ----
  const rollup = useMemo(() => {
    let liked = 0,
      likedKm = 0,
      vetoed = 0;
    for (const t of doc.tracks) {
      const v = verdict(fb("track", t.id));
      if (v === "yes") {
        liked++;
        likedKm += t.km ?? 0;
      } else if (v === "no") vetoed++;
    }
    return {
      liked,
      likedKm: Math.round(likedKm),
      vetoed,
      undecided: doc.tracks.length - liked - vetoed,
    };
  }, [doc.tracks, fb]);

  // Collections legend (original-colour mode): unique collection → colour.
  const collections = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of doc.tracks) {
      const c = cssColor(t.color);
      if (t.collection && c && !seen.has(t.collection)) seen.set(t.collection, c);
    }
    return Array.from(seen, ([name, color]) => ({ name, color }));
  }, [doc.tracks]);

  // ---- map data ----
  const buildFC = useCallback(
    (f: Feedback) => ({
      type: "FeatureCollection" as const,
      features: doc.tracks.map((t) => ({
        type: "Feature" as const,
        properties: {
          id: t.id,
          verdict: verdict(f[`track:${t.id}`]),
          color: cssColor(t.color),
        },
        geometry: t.geometry,
      })),
    }),
    [doc.tracks],
  );

  const poiFC = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: (doc.pois ?? []).map((p, i) => ({
        type: "Feature" as const,
        properties: { idx: i, category: p.category ?? "poi" },
        geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
      })),
    }),
    [doc.pois],
  );

  // Padded plan bounding box — the closures route trims NSW/VIC noise to it.
  const planBbox = useMemo(() => {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const t of doc.tracks) {
      for (const [lon, lat] of coordsOf(t.geometry)) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!Number.isFinite(minLon)) return null;
    const pad = 0.45; // ~50 km, same reach as the daemon's library filter
    return [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad];
  }, [doc.tracks]);

  // Live closures — fetched once; 15-min freshness handled by the route.
  useEffect(() => {
    if (!planBbox) return;
    let cancelled = false;
    fetch(`/api/closures?bbox=${planBbox.map((n) => n.toFixed(3)).join(",")}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((fc) => {
        if (cancelled || !fc?.features) return;
        setClosures(fc);
        const src = mapRef.current?.getSource("closures") as
          | maplibreNs.GeoJSONSource
          | undefined;
        if (src) src.setData(fc);
      })
      .catch(() => {
        /* advisory layer — silently absent */
      });
    return () => {
      cancelled = true;
    };
  }, [planBbox]);

  // ---- selection ----
  const applySelection = (map: maplibreNs.Map, ids: string[]) => {
    const filter: maplibreNs.FilterSpecification = [
      "in",
      ["get", "id"],
      ["literal", ids],
    ] as unknown as maplibreNs.FilterSpecification;
    map.setFilter("track-active-casing", filter);
    map.setFilter("track-active", filter);
  };

  const setSelection = (ids: string[]) => {
    setSelectedIds(ids);
    selectedRef.current = ids;
    const map = mapRef.current;
    if (map && map.getLayer("track-active")) applySelection(map, ids);
  };

  /** Toggle a track in the selection. Selecting (from the list or the map)
   *  also zooms to it and scrolls its row into view; unselecting does not. */
  const toggleTrack = (t: PlanTrack, zoom: boolean) => {
    const cur = selectedRef.current;
    if (cur.includes(t.id)) {
      setSelection(cur.filter((id) => id !== t.id));
      return;
    }
    setSelection([...cur, t.id]);
    document
      .getElementById(`plan-track-${t.id}`)
      ?.scrollIntoView({ block: "nearest" });
    if (!zoom) return;
    const map = mapRef.current;
    const ml = window.maplibregl;
    if (!map || !ml) return;
    const cs = coordsOf(t.geometry);
    if (!cs.length) return;
    const bounds = cs.reduce(
      (b, c) => b.extend(c as [number, number]),
      new ml.LngLatBounds(cs[0], cs[0]),
    );
    map.fitBounds(bounds, { padding: 60, maxZoom: 11 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- track paint (colour-by switch) ----
  const trackPaint = (mode: ColorBy) => {
    const verdictColor = [
      "match",
      ["get", "verdict"],
      "yes",
      VERDICT_COLORS.yes,
      "maybe",
      VERDICT_COLORS.maybe,
      "no",
      VERDICT_COLORS.no,
      VERDICT_COLORS.none,
    ];
    return {
      color: (mode === "votes"
        ? verdictColor
        : ["coalesce", ["get", "color"], TRACK_COLOR]) as unknown as maplibreNs.ExpressionSpecification,
      opacity: (mode === "votes"
        ? ["match", ["get", "verdict"], "no", 0.45, 0.92]
        : 0.92) as unknown as maplibreNs.ExpressionSpecification,
    };
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("tracks")) return;
    const p = trackPaint(colorBy);
    map.setPaintProperty("tracks", "line-color", p.color);
    map.setPaintProperty("tracks", "line-opacity", p.opacity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorBy]);

  // ---- overlay visibility toggles ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("pois-circles")) return;
    map.setLayoutProperty("pois-circles", "visibility", showPois ? "visible" : "none");
  }, [showPois]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const l of ["closures-line", "closures-point"]) {
      if (map.getLayer(l))
        map.setLayoutProperty(l, "visibility", showClosures ? "visible" : "none");
    }
  }, [showClosures]);

  // ---- map lifecycle (recreated on basemap/detail switch; layer setup
  //      stays in one place, the load handler) ----
  useEffect(() => {
    const container = mapDiv.current;
    if (!container) return;
    // Cards anchor to screen positions on the old map — close them.
    setClosureCard(null);
    setPoiCard(null);
    let cancelled = false;
    let map: maplibreNs.Map | null = null;
    (async () => {
      const ml = await loadMaplibre();
      if (cancelled) return;
      let style: maplibreNs.StyleSpecification | undefined;
      if (basemap === "dingo") {
        ensurePmtilesProtocol(ml as unknown as { addProtocol: (s: string, f: unknown) => void });
        try {
          style = await buildDingoStyle(detail);
        } catch {
          style = undefined; // fall back to topo raster below
        }
        if (cancelled) return;
      }
      map = createMap(ml, container, style);
    })();
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, detail]);

  const createMap = (
    ml: MaplibreNS,
    container: HTMLDivElement,
    dingoStyle?: maplibreNs.StyleSpecification,
  ) => {
    const source = RASTER_BASEMAPS[basemap] ?? RASTER_BASEMAPS.topo;
    const style: maplibreNs.StyleSpecification =
      dingoStyle ?? {
        version: 8,
        sources: {
          base: {
            type: "raster",
            tiles: source.tiles,
            tileSize: 256,
            attribution: source.attribution,
            maxzoom: source.maxzoom,
          },
        },
        layers: [{ id: "base", type: "raster", source: "base" }],
      };
    const map = new ml.Map({
      container,
      style,
      center: [134, -26],
      zoom: 3.5,
    });
    mapRef.current = map;
    // Debug handle + surfaced errors, mirroring Plan's __dingoMap convention.
    (window as unknown as Record<string, unknown>).__planMap = map;
    map.on("error", (e) => console.error("[plan-map]", e.error ?? e));
    map.addControl(new ml.NavigationControl(), "top-left");
    new ResizeObserver(() => map.resize()).observe(container);

    map.on("load", () => {
      map.addSource("tracks", {
        type: "geojson",
        data: buildFC(feedbackRef.current) as GeoJSON.FeatureCollection,
      });
      const paint = trackPaint(colorByRef.current);
      map.addLayer({
        id: "tracks-casing",
        type: "line",
        source: "tracks",
        paint: { "line-color": "#14100c", "line-width": 4, "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "tracks",
        type: "line",
        source: "tracks",
        paint: {
          "line-color": paint.color,
          "line-width": 2.2,
          "line-opacity": paint.opacity,
        },
      });
      // Selection must be unmistakable: ~3x width over a wide casing.
      map.addLayer({
        id: "track-active-casing",
        type: "line",
        source: "tracks",
        paint: { "line-color": "#fffbf2", "line-width": 13, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "track-active",
        type: "line",
        source: "tracks",
        paint: {
          "line-color": (["coalesce", ["get", "color"], TRACK_COLOR]) as unknown as maplibreNs.ExpressionSpecification,
          "line-width": 9,
          "line-opacity": 1,
        },
      });
      applySelection(map, selectedRef.current);

      // Road closures: above the tracks (a closure must beat line clutter),
      // below POIs. Advisory — click for the source text.
      map.addSource("closures", {
        type: "geojson",
        data: (closuresRef.current ?? {
          type: "FeatureCollection",
          features: [],
        }) as GeoJSON.FeatureCollection,
      });
      const closureColor = [
        "match",
        ["get", "status"],
        "warning",
        CLOSURE_COLORS.warning,
        "4wd",
        CLOSURE_COLORS["4wd"],
        CLOSURE_COLORS.closed,
      ] as unknown as maplibreNs.ExpressionSpecification;
      map.addLayer({
        id: "closures-line",
        type: "line",
        source: "closures",
        filter: ["!=", ["geometry-type"], "Point"],
        layout: { visibility: showClosures ? "visible" : "none" },
        paint: { "line-color": closureColor, "line-width": 3, "line-opacity": 0.85 },
      });
      // Point features are closures the upstream ships without line geometry.
      map.addLayer({
        id: "closures-point",
        type: "circle",
        source: "closures",
        filter: ["==", ["geometry-type"], "Point"],
        layout: { visibility: showClosures ? "visible" : "none" },
        paint: {
          "circle-color": closureColor,
          "circle-radius": 6,
          "circle-opacity": 0.9,
          "circle-stroke-color": "#14100c",
          "circle-stroke-width": 1,
        },
      });

      // POI pins (top): category-coloured dots, min zoom keeps a zoomed-out
      // map from drowning in them.
      map.addSource("pois", {
        type: "geojson",
        data: poiFC as GeoJSON.FeatureCollection,
      });
      map.addLayer({
        id: "pois-circles",
        type: "circle",
        source: "pois",
        minzoom: 6,
        layout: { visibility: showPois ? "visible" : "none" },
        paint: {
          "circle-color": ([
            "match",
            ["get", "category"],
            ...Object.entries(POI_META).flatMap(([k, m]) => [k, m.color]),
            POI_META.poi.color,
          ]) as unknown as maplibreNs.ExpressionSpecification,
          "circle-radius": 5,
          "circle-stroke-color": "#fffbf2",
          "circle-stroke-width": 1.5,
        },
      });

      // One click handler, top overlay wins: POI > closure > track.
      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: [
            "pois-circles",
            "closures-line",
            "closures-point",
            "track-active",
            "tracks",
          ].filter((l) => !!map.getLayer(l)),
        });
        const poiHit = hits.find((h) => h.layer.id === "pois-circles");
        if (poiHit) {
          const poi = doc.pois?.[poiHit.properties.idx as number];
          if (poi) {
            setCards(null, { x: e.point.x, y: e.point.y, poi });
            return;
          }
        }
        const closureHit = hits.find((h) => h.layer.id.startsWith("closures-"));
        if (closureHit) {
          setCards(
            { x: e.point.x, y: e.point.y, c: closureHit.properties as unknown as ClosureProps },
            null,
          );
          return;
        }
        setCards(null, null);
        const trackHit = hits.find(
          (h) => h.layer.id === "tracks" || h.layer.id === "track-active",
        );
        if (trackHit) {
          const t = doc.tracks.find((x) => x.id === trackHit.properties.id);
          if (t) toggleTrack(t, false);
        }
      });
      const pointerLayers = ["tracks", "track-active", "pois-circles", "closures-line", "closures-point"];
      for (const l of pointerLayers) {
        map.on("mouseenter", l, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", l, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      const all = doc.tracks.flatMap((t) => coordsOf(t.geometry));
      if (all.length) {
        const bounds = all.reduce(
          (b, c) => b.extend(c as [number, number]),
          new ml.LngLatBounds(all[0], all[0]),
        );
        map.fitBounds(bounds, { padding: 40 });
      }

      for (const m of doc.marks ?? []) {
        const el = document.createElement("div");
        el.textContent = m.icon || "⛺";
        el.style.cssText =
          "font-size:20px;cursor:pointer;text-shadow:0 1px 3px rgba(0,0,0,.6)";
        el.title = m.name;
        el.onclick = () =>
          document
            .getElementById(`plan-mark-${m.id}`)
            ?.scrollIntoView({ block: "center" });
        new ml.Marker({ element: el }).setLngLat([m.lon, m.lat]).addTo(map);
      }
    });

    return map;
  };

  /** One open card at a time; a map click elsewhere closes both. */
  const setCards = (
    closure: { x: number; y: number; c: ClosureProps } | null,
    poi: { x: number; y: number; poi: PlanPoi } | null,
  ) => {
    setClosureCard(closure);
    setPoiCard(poi);
  };

  // ---- widgets ----
  const saveName = () => {
    const v = nameDraft.trim().slice(0, 24);
    if (!v) return;
    localStorage.setItem(NAME_KEY, v);
    setMe(v);
    setAskName(false);
  };

  const tallyLabel = (f?: ItemFeedback) => {
    const c = tally(f);
    const bits = [];
    if (c.yes) bits.push(<span key="y" className="text-[#57a557]">{c.yes} yes</span>);
    if (c.maybe) bits.push(<span key="m" className="text-[#c9a227]">{c.maybe} maybe</span>);
    if (c.no) bits.push(<span key="n" className="text-[#c96a5a]">{c.no} no</span>);
    if (!bits.length) return <span>no votes yet</span>;
    return bits.flatMap((b, i) => (i ? [" · ", b] : [b]));
  };

  const voteButtons = (itemType: "track" | "mark", id: string) => {
    const mine = me ? fb(itemType, id)?.votes[me] : undefined;
    const btn = (v: "yes" | "maybe" | "no", label: string, on: string) => (
      <button
        key={v}
        onClick={(e) => {
          e.stopPropagation();
          post(itemType, id, { vote: v });
        }}
        className={`rounded border px-2.5 py-0.5 text-xs font-semibold transition-colors ${
          mine === v
            ? `${on} text-ink`
            : "border-line text-bone-dim hover:text-bone"
        }`}
      >
        {label}
      </button>
    );
    return (
      <span className="flex gap-1.5">
        {btn("yes", "Yes", "border-[#57a557] bg-[#57a557]")}
        {btn("maybe", "Maybe", "border-[#c9a227] bg-[#c9a227]")}
        {btn("no", "No", "border-[#c96a5a] bg-[#c96a5a]")}
      </span>
    );
  };

  const comments = (f?: ItemFeedback) =>
    (f?.comments ?? []).map((c, i) => (
      <p key={i} className="mt-1 text-xs italic text-bone-dim">
        <span className="font-semibold not-italic text-bone">{c.who}:</span>{" "}
        {c.text}
      </p>
    ));

  const commentBox = (itemType: "track" | "mark", id: string) => (
    <input
      className="mt-2 w-full rounded border border-line bg-ink px-2 py-1 text-xs text-bone placeholder:text-bone-dim/60"
      placeholder="add a comment… (enter)"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        const text = (e.target as HTMLInputElement).value.trim();
        if (!text) return;
        post(itemType, id, { comment: text });
        (e.target as HTMLInputElement).value = "";
      }}
    />
  );

  /** A row of small radio-style buttons for the map control stack. */
  const controlRow = <T extends string>(
    entries: [T, string][],
    active: T,
    onPick: (v: T) => void,
  ) => (
    <div className="flex overflow-hidden rounded border border-line bg-ink/90 text-xs">
      {entries.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onPick(key)}
          className={`px-2.5 py-1.5 uppercase tracking-wider transition-colors ${
            active === key ? "bg-clay text-ink" : "text-bone-dim hover:text-bone"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const toggleChip = (label: string, on: boolean, onToggle: () => void) => (
    <button
      onClick={onToggle}
      className={`rounded border px-2.5 py-1.5 text-xs uppercase tracking-wider transition-colors ${
        on
          ? "border-clay bg-ink/90 text-clay-hot"
          : "border-line bg-ink/90 text-bone-dim hover:text-bone"
      }`}
    >
      {label}
    </button>
  );

  const mapW = () => mapDiv.current?.clientWidth || 800;
  const mapH = () => mapDiv.current?.clientHeight || 600;

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-[480px] flex-col md:flex-row">
      <div className="order-2 h-1/2 w-full overflow-y-auto border-t border-line md:order-1 md:h-full md:w-[400px] md:border-r md:border-t-0">
        <div className="border-b border-line px-4 py-3 text-sm text-bone-dim">
          <div>
            <span className="text-[#57a557]">{rollup.liked} liked</span>
            {rollup.liked ? ` (${rollup.likedKm.toLocaleString()} km)` : ""} ·{" "}
            <span className="text-[#c96a5a]">{rollup.vetoed} vetoed</span> ·{" "}
            {rollup.undecided} undecided
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            sort
            <select
              value={sort}
              onChange={(e) => pickSort(e.target.value as SortMode)}
              className="rounded border border-line bg-ink px-1.5 py-0.5 text-xs text-bone"
            >
              <option value="wanted">most wanted</option>
              <option value="name">name</option>
              <option value="km">distance</option>
              <option value="unvoted">needs my vote</option>
            </select>
            <span className="ml-auto">
              {me ? (
                <button
                  className="text-bone-dim underline hover:text-bone"
                  onClick={() => {
                    setNameDraft(me);
                    setAskName(true);
                  }}
                  title="Change the name your votes are recorded under"
                >
                  voting as {me}
                </button>
              ) : (
                <button
                  className="text-clay-hot underline"
                  onClick={() => setAskName(true)}
                >
                  set your name to vote
                </button>
              )}
            </span>
          </div>
          {selectedIds.length > 0 && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span>
                {selectedIds.length} selected — click a selected track to
                unselect it
              </span>
              <button
                className="ml-auto text-bone-dim underline hover:text-bone"
                onClick={() => setSelection([])}
                title="Clear the selection (Esc)"
              >
                clear
              </button>
            </div>
          )}
          {postError && (
            <div className="mt-2 text-xs text-[#c96a5a]">{postError}</div>
          )}
        </div>
        {tracksInOrder.map((t) => {
          const active = selectedIds.includes(t.id);
          const f = fb("track", t.id);
          const swatch = cssColor(t.color);
          return (
            <div
              key={t.id}
              id={`plan-track-${t.id}`}
              onClick={() => toggleTrack(t, true)}
              className={`cursor-pointer border-b border-line px-4 py-3 transition-colors hover:bg-ink-2/60 ${
                active ? "bg-ink-2 shadow-[inset_3px_0_0_#e07a3f]" : ""
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-bone">
                {swatch && (
                  <i
                    className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ background: swatch }}
                    title={t.collection ?? undefined}
                  />
                )}
                {t.name}
              </div>
              <div className="mt-0.5 text-xs text-bone-dim">
                {t.km ? `${t.km} km` : ""}
                {t.region || t.state ? ` · ${t.region || t.state}` : ""}
                {t.grade ? ` · ${t.grade}` : ""}
              </div>
              <div className="mt-2 flex items-center gap-2">
                {voteButtons("track", t.id)}
                <span className="ml-auto whitespace-nowrap text-xs text-bone-dim">
                  {tallyLabel(f)}
                </span>
              </div>
              {t.description && (
                <p
                  className={`mt-1.5 text-xs text-bone-dim/90 ${
                    active ? "whitespace-pre-line" : "line-clamp-2"
                  }`}
                >
                  {t.description}
                </p>
              )}
              {comments(f)}
              {active && commentBox("track", t.id)}
            </div>
          );
        })}
        {(doc.marks?.length ?? 0) > 0 && (
          <>
            <div className="border-b border-line px-4 py-2 text-xs uppercase tracking-wider text-bone-dim">
              Stops & accommodation
            </div>
            {doc.marks!.map((m) => {
              const f = fb("mark", m.id);
              return (
                <div
                  key={m.id}
                  id={`plan-mark-${m.id}`}
                  onClick={() =>
                    mapRef.current?.flyTo({ center: [m.lon, m.lat], zoom: 9 })
                  }
                  className="cursor-pointer border-b border-line px-4 py-2.5 transition-colors hover:bg-ink-2/60"
                >
                  <div className="text-sm text-bone">
                    <span className="mr-2">{m.icon || "⛺"}</span>
                    {m.name}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    {voteButtons("mark", m.id)}
                    <span className="ml-auto whitespace-nowrap text-xs text-bone-dim">
                      {tallyLabel(f)}
                    </span>
                  </div>
                  {comments(f)}
                </div>
              );
            })}
          </>
        )}
      </div>
      <div className="relative order-1 h-1/2 flex-1 md:order-2 md:h-full">
        {/* maplibre-gl.css loads at runtime after the app styles and its
            .maplibregl-map { position: relative } outranks Tailwind's
            .absolute by order, collapsing the container to height 0 —
            the inline style keeps the map filling its parent. */}
        <div ref={mapDiv} className="absolute inset-0" style={{ position: "absolute" }} />
        <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
          {controlRow(
            (Object.keys(BASEMAP_LABELS) as BasemapId[]).map((k) => [k, BASEMAP_LABELS[k]] as [BasemapId, string]),
            basemap,
            setBasemap,
          )}
          {basemap === "dingo" &&
            controlRow(
              (Object.keys(DETAIL_LABELS) as DetailLevel[]).map((k) => [k, DETAIL_LABELS[k]] as [DetailLevel, string]),
              detail,
              setDetail,
            )}
          {controlRow(
            [
              ["original", "Colours"],
              ["votes", "Votes"],
            ] as [ColorBy, string][],
            colorBy,
            setColorBy,
          )}
          <div className="flex gap-2">
            {(doc.pois?.length ?? 0) > 0 &&
              toggleChip("POIs", showPois, () => setShowPois((v) => !v))}
            {toggleChip("Closures", showClosures, () => setShowClosures((v) => !v))}
          </div>
        </div>
        <div className="absolute bottom-6 left-3 z-10 max-w-[60%] rounded border border-line bg-ink/90 px-3 py-1.5 text-xs text-bone-dim">
          {colorBy === "votes" ? (
            <>
              <span className="mr-3"><i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: VERDICT_COLORS.yes }} />liked</span>
              <span className="mr-3"><i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: VERDICT_COLORS.maybe }} />maybe</span>
              <span className="mr-3"><i className="mr-1 inline-block h-1 w-4 rounded opacity-50" style={{ background: VERDICT_COLORS.no }} />vetoed</span>
              <span><i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: VERDICT_COLORS.none }} />unvoted</span>
            </>
          ) : collections.length ? (
            collections.slice(0, 8).map((c) => (
              <span key={c.name} className="mr-3 whitespace-nowrap">
                <i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: c.color }} />
                {c.name}
              </span>
            ))
          ) : (
            <span>
              <i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: TRACK_COLOR }} />
              tracks
            </span>
          )}
        </div>

        {closureCard && (() => {
          const cardW = 300;
          const left = Math.min(Math.max(closureCard.x - cardW / 2, 8), mapW() - cardW - 8);
          const showAbove = closureCard.y > 260;
          const c = closureCard.c;
          const color = CLOSURE_COLORS[c.status] ?? CLOSURE_COLORS.closed;
          const statusLabel =
            c.status === "closed" ? "Closed" : c.status === "4wd" ? "4WD only" : "Open with warnings";
          return (
            <div
              className="absolute z-20 rounded-lg border border-line bg-ink/95 p-3 text-xs text-bone shadow-xl"
              style={{
                left,
                width: cardW,
                ...(showAbove
                  ? { bottom: mapH() - closureCard.y + 16 }
                  : { top: closureCard.y + 16 }),
              }}
            >
              <button
                onClick={() => setClosureCard(null)}
                title="Close"
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center text-bone-dim hover:text-bone"
              >
                ×
              </button>
              <div className="flex items-center gap-2 pr-4">
                <i className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: color }} />
                <span className="font-semibold">{c.name}</span>
              </div>
              <div className="mt-1 text-bone-dim">
                {statusLabel}
                {c.kind ? ` · ${c.kind}` : ""}
                {c.area ? ` · ${c.area}` : ""}
              </div>
              {c.detail && (
                <div className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap text-bone-dim/90">
                  {c.detail}
                </div>
              )}
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-clay-hot underline"
              >
                {c.src} source ↗
              </a>
            </div>
          );
        })()}

        {poiCard && (() => {
          const cardW = 260;
          const left = Math.min(Math.max(poiCard.x - cardW / 2, 8), mapW() - cardW - 8);
          const showAbove = poiCard.y > 220;
          const p = poiCard.poi;
          const meta = poiMeta(p.category);
          return (
            <div
              className="absolute z-20 rounded-lg border border-line bg-ink/95 p-3 text-xs text-bone shadow-xl"
              style={{
                left,
                width: cardW,
                ...(showAbove
                  ? { bottom: mapH() - poiCard.y + 14 }
                  : { top: poiCard.y + 14 }),
              }}
            >
              <button
                onClick={() => setPoiCard(null)}
                title="Close"
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center text-bone-dim hover:text-bone"
              >
                ×
              </button>
              <div className="flex items-center gap-2 pr-4">
                <span>{meta.emoji}</span>
                <span className="font-semibold">{p.name || meta.label}</span>
              </div>
              <div className="mt-1 text-bone-dim">
                {meta.label}
                {p.collection ? ` · ${p.collection}` : ""}
              </div>
              {p.description && (
                <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-bone-dim/90">
                  {p.description}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {askName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70">
          <div className="w-80 rounded-lg border border-line bg-ink-2 p-6 shadow-xl">
            <h2 className="font-display text-lg font-bold uppercase">
              Who are you?
            </h2>
            <p className="mt-1 text-sm text-bone-dim">
              Shown next to your votes and comments. Remembered on this
              device.
            </p>
            <input
              autoFocus
              maxLength={24}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              placeholder="e.g. Dave"
              className="mt-4 w-full rounded border border-line bg-ink px-3 py-2 text-sm text-bone"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={saveName}
                className="flex-1 rounded bg-clay px-4 py-2 font-display font-bold uppercase text-ink transition-colors hover:bg-clay-hot"
              >
                Start voting
              </button>
              <button
                onClick={() => setAskName(false)}
                className="rounded border border-line px-4 py-2 text-sm text-bone-dim hover:text-bone"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
