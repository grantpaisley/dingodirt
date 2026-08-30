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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type * as maplibreNs from "maplibre-gl";
// One canonical copy in core/ui (turbopack.root spans the monorepo so
// this import can leave apps/site — see next.config.ts).
import "../../../../../core/ui/tokens.css";
import "../../../../../core/ui/chrome.css";
import {
  buildDingoStyle,
  ensurePmtilesProtocol,
  type DetailLevel,
} from "./dingoStyle";
import {
  PIN_CATEGORIES,
  addPinImages,
  markCategory,
  pinDataUrl,
  pinMeta,
} from "./pinIcons";

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
  /** Emoji fallback the doc has carried since the first plan publish. */
  icon?: string | null;
  /** Raw DingoNav mark kind — picks the badge. Absent on older docs. */
  kind?: string | null;
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

// ---- phone shell (docs/plans/2026-08-30-track-graph-and-phone-plan-design.md)
// Below md the page is a full map plus a four-tab bar. Level 2 is the shared
// .dd-sheet (core/ui/chrome.css docks it bottom in portrait, left in
// landscape); level 3 is a page pushed inside that same sheet, so the sheet
// never grows. Desktop keeps the two-pane layout untouched.
type Shell = "desktop" | "portrait" | "landscape";
type TabId = "tracks" | "map" | "trip" | "me";
type SheetPage =
  | { kind: "track"; id: string }
  | { kind: "option"; which: "basemap" | "detail" | "colours" }
  | { kind: "group"; which: "liked" | "undecided" | "vetoed" };

const TAB_KEY = "dingo-plan-tab";
const TABS: { id: TabId; label: string; d: string }[] = [
  { id: "tracks", label: "Tracks", d: "M3 5h14M3 10h14M3 15h9" },
  { id: "map", label: "Map", d: "M10 3 3 6.5 10 10l7-3.5L10 3M3 13.5 10 17l7-3.5" },
  { id: "trip", label: "Trip", d: "M5 16a2 2 0 1 0 0-4h10a2 2 0 1 0 0-4M5 16h10" },
  { id: "me", label: "Me", d: "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M4 17a6 6 0 0 1 12 0" },
];
const GROUP_LABELS: Record<"liked" | "undecided" | "vetoed", string> = {
  liked: "Liked",
  undecided: "Undecided",
  vetoed: "Vetoed",
};

// MapLibre paint needs literals; these mirror core/ui/tokens.css —
// TRACK_COLOR is --dd-accent (the clay fallback for tracks without an
// original colour), VERDICT_COLORS are the muted --dd-status-* triad.
const TRACK_COLOR = "#d96f32";
const VERDICT_COLORS: Record<string, string> = {
  yes: "#57a557",
  maybe: "#c9a227",
  no: "#8a4a42",
  none: "#8a8177",
};

/** Badge pin, at the size the list rows and cards want. */
const PinBadge = ({ category, size = 18 }: { category: string; size?: number }) => (
  // eslint-disable-next-line @next/next/no-img-element -- canvas data URL
  <img
    src={pinDataUrl(category)}
    alt=""
    width={size}
    height={size}
    className="shrink-0"
  />
);

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
  // Phone shell. The first render is always 'desktop' so the server HTML and
  // the first client render agree; an effect corrects it.
  const [shell, setShell] = useState<Shell>("desktop");
  const [tab, setTab] = useState<TabId | null>(null);
  const [pages, setPages] = useState<SheetPage[]>([]);
  const [copied, setCopied] = useState(false);
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
    const saved = localStorage.getItem(TAB_KEY) as TabId | null;
    if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
  }, []);

  // The shell follows the viewport's SHORT edge, not its width: a phone in
  // landscape is ~844 px wide, so a plain max-width query would call it a
  // desktop. The long-edge cap keeps a short, wide desktop window out.
  // The sheet's own docking follows orientation in CSS; this only decides
  // bar-versus-rail and which tree renders.
  useEffect(() => {
    const sync = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const isPhone = Math.min(w, h) <= 599 && Math.max(w, h) <= 1180;
      setShell(!isPhone ? "desktop" : w > h ? "landscape" : "portrait");
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, []);

  useEffect(() => {
    if (tab) localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  // Any shell or sheet change resizes the map's container.
  useEffect(() => {
    const id = window.setTimeout(() => mapRef.current?.resize(), 60);
    return () => window.clearTimeout(id);
  }, [shell, tab]);

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
      features: (doc.pois ?? []).map((p, i) => {
        // Resolve here, not in the layer expression: an unknown category
        // would ask maplibre for a `pin-*` image that was never added, and
        // the pin would silently vanish.
        const category = PIN_CATEGORIES[p.category ?? "poi"] ? p.category! : "poi";
        return {
          type: "Feature" as const,
          properties: {
            idx: i,
            category,
            priority: pinMeta(category).priority,
          },
          geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
        };
      }),
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

  const zoomToTrack = (t: PlanTrack) => {
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
    if (zoom) zoomToTrack(t);
  };

  /** A map tap on a phone opens that track's level-3 page. The map's click
   *  handler is registered once, so it reaches the current shell by ref. */
  const openTrackPage = useRef<(t: PlanTrack) => void>(() => {});

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
    if (!map || !map.getLayer("pois-icons")) return;
    map.setLayoutProperty("pois-icons", "visibility", showPois ? "visible" : "none");
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

      // POI pins (top): the Plan app's badge icons, min zoom keeps a
      // zoomed-out map from drowning in them. Icons collide rather than
      // stack, and the lowest sort key wins — fuel and camps outrank a
      // generic pin in a crowded corridor, as they do in Plan.
      addPinImages(map);
      map.addSource("pois", {
        type: "geojson",
        data: poiFC as GeoJSON.FeatureCollection,
      });
      map.addLayer({
        id: "pois-icons",
        type: "symbol",
        source: "pois",
        minzoom: 6,
        layout: {
          visibility: showPois ? "visible" : "none",
          "icon-image": ["concat", "pin-", ["get", "category"]],
          "icon-size": 0.75,
          "icon-padding": 2,
          "symbol-sort-key": ["get", "priority"],
        },
      });

      // One click handler, top overlay wins: POI > closure > track.
      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: [
            "pois-icons",
            "closures-line",
            "closures-point",
            "track-active",
            "tracks",
          ].filter((l) => !!map.getLayer(l)),
        });
        const poiHit = hits.find((h) => h.layer.id === "pois-icons");
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
          if (t) {
            toggleTrack(t, false);
            openTrackPage.current(t);
          }
        }
      });
      const pointerLayers = ["tracks", "track-active", "pois-icons", "closures-line", "closures-point"];
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

      // Marks stay DOM markers — they always sit above the POI symbols and
      // a click scrolls the list to the matching row — but they wear the
      // same badge the POI pins do.
      for (const m of doc.marks ?? []) {
        const el = document.createElement("img");
        el.src = pinDataUrl(markCategory(m.kind, m.name));
        el.style.cssText =
          "width:26px;height:26px;cursor:pointer;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5))";
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
    if (c.yes) bits.push(<span key="y" className="dd-chip ok">{c.yes} yes</span>);
    if (c.maybe) bits.push(<span key="m" className="dd-chip mid">{c.maybe} maybe</span>);
    if (c.no) bits.push(<span key="n" className="dd-chip bad">{c.no} no</span>);
    if (!bits.length) return <span>no votes yet</span>;
    return <span className="inline-flex gap-1">{bits}</span>;
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
          mine === v ? on : "border-line text-bone-dim hover:text-bone"
        }`}
      >
        {label}
      </button>
    );
    return (
      <span className="flex gap-1.5">
        {btn("yes", "Yes", "border-[var(--dd-status-ok)] bg-[var(--dd-status-ok)] text-[var(--dd-on-status-ok)]")}
        {btn("maybe", "Maybe", "border-[var(--dd-status-mid)] bg-[var(--dd-status-mid)] text-[var(--dd-on-status-mid)]")}
        {btn("no", "No", "border-[var(--dd-status-bad)] bg-[var(--dd-status-bad)] text-[var(--dd-on-status-bad)]")}
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

  /** A segmented switch for the map control stack (core/ui .dd-seg, Rule 7). */
  const controlRow = <T extends string>(
    entries: [T, string][],
    active: T,
    onPick: (v: T) => void,
  ) => (
    <div className="dd-seg text-xs">
      {entries.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onPick(key)}
          className={`uppercase tracking-wider transition-colors ${
            active === key ? "is-active" : ""
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  /** A filter pill for map overlays (core/ui .dd-pill, Rule 7). */
  const toggleChip = (label: string, on: boolean, onToggle: () => void) => (
    <button
      onClick={onToggle}
      className={`dd-pill text-xs uppercase tracking-wider transition-colors ${
        on ? "is-active" : ""
      }`}
    >
      {label}
    </button>
  );

  const mapW = () => mapDiv.current?.clientWidth || 800;
  const mapH = () => mapDiv.current?.clientHeight || 600;

  // ---- phone shell ----
  const phone = shell !== "desktop";
  const landscape = shell === "landscape";
  const page = pages.length ? pages[pages.length - 1] : null;
  const pushPage = (p: SheetPage) => setPages((s) => [...s, p]);
  const closeSheet = () => {
    setTab(null);
    setPages([]);
  };

  useEffect(() => {
    openTrackPage.current = (t: PlanTrack) => {
      if (!phone) return;
      setTab("tracks");
      setPages([{ kind: "track", id: t.id }]);
    };
  }, [phone]);

  const verdictOf = (id: string) => verdict(fb("track", id));
  const groupTracks = (which: "liked" | "undecided" | "vetoed") =>
    tracksInOrder.filter((t) => {
      const v = verdictOf(t.id);
      return which === "liked" ? v === "yes"
        : which === "vetoed" ? v === "no"
        : v !== "yes" && v !== "no";
    });

  /** The legend, shared by the desktop map corner and the phone Map tab. */
  const legendBody =
    colorBy === "votes" ? (
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
    );

  const sortSelect = (
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
  );

  const nameButton = me ? (
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
    <button className="text-clay-hot underline" onClick={() => setAskName(true)}>
      set your name to vote
    </button>
  );

  const trackMeta = (t: PlanTrack) =>
    `${t.km ? `${t.km} km` : ""}${t.region || t.state ? ` · ${t.region || t.state}` : ""}${t.grade ? ` · ${t.grade}` : ""}`;

  /** One track row. onPick decides what a tap does: the desktop list toggles
   *  the selection, the phone list opens the track's level-3 page. */
  const trackRow = (t: PlanTrack, onPick: () => void, expandable: boolean) => {
    const active = selectedIds.includes(t.id);
    const f = fb("track", t.id);
    const swatch = cssColor(t.color);
    return (
      <div
        key={t.id}
        id={`plan-track-${t.id}`}
        onClick={onPick}
        className={`cursor-pointer border-b border-line px-4 py-3 transition-colors hover:bg-ink-2/60 ${
          active ? "bg-ink-2 shadow-[inset_3px_0_0_var(--dd-accent)]" : ""
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
        <div className="mt-0.5 text-xs text-bone-dim">{trackMeta(t)}</div>
        <div className="mt-2 flex items-center gap-2">
          {voteButtons("track", t.id)}
          <span className="ml-auto whitespace-nowrap text-xs text-bone-dim">
            {tallyLabel(f)}
          </span>
        </div>
        {t.description && (
          <p
            className={`mt-1.5 text-xs text-bone-dim/90 ${
              expandable && active ? "whitespace-pre-line" : "line-clamp-2"
            }`}
          >
            {t.description}
          </p>
        )}
        {comments(f)}
        {expandable && active && commentBox("track", t.id)}
      </div>
    );
  };

  const markRows = (doc.marks?.length ?? 0) > 0 && (
    <>
      <div className="border-b border-line px-4 py-2 text-xs uppercase tracking-wider text-bone-dim">
        Stops &amp; accommodation
      </div>
      {doc.marks!.map((m) => {
        const f = fb("mark", m.id);
        return (
          <div
            key={m.id}
            id={`plan-mark-${m.id}`}
            onClick={() => {
              mapRef.current?.flyTo({ center: [m.lon, m.lat], zoom: 9 });
              if (phone) closeSheet();
            }}
            className="cursor-pointer border-b border-line px-4 py-2.5 transition-colors hover:bg-ink-2/60"
          >
            <div className="flex items-center gap-2 text-sm text-bone">
              <PinBadge category={markCategory(m.kind, m.name)} />
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
  );

  // ---- sheet rows (level 2) ----
  const sheetRow = (label: string, right: ReactNode, onClick?: () => void) => (
    <button
      key={label}
      onClick={onClick}
      className="flex w-full items-center justify-between border-b border-line px-4 py-3 text-left text-sm text-bone"
    >
      <span>{label}</span>
      <span className="flex items-center gap-1.5 text-xs text-bone-dim">{right}</span>
    </button>
  );

  const chevron = <span aria-hidden="true">›</span>;

  const switchRow = (label: string, on: boolean, onToggle: () => void) =>
    sheetRow(
      label,
      <span
        className={`inline-block h-4 w-7 rounded-full transition-colors ${
          on ? "bg-[var(--dd-accent)]" : "bg-line"
        }`}
      >
        <span
          className={`mt-0.5 block h-3 w-3 rounded-full bg-ink transition-transform ${
            on ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>,
      onToggle,
    );

  const optionList = <T extends string>(
    entries: [T, string][],
    active: T,
    pick: (v: T) => void,
  ) => (
    <>
      {entries.map(([key, label]) =>
        sheetRow(label, active === key ? <span aria-hidden="true">✓</span> : null, () => {
          pick(key);
          setPages((s) => s.slice(0, -1));
        }),
      )}
    </>
  );

  const myVotes = me
    ? Object.values(feedback).filter((f) => f.votes?.[me]).length
    : 0;
  const shareUrl = typeof window === "undefined" ? "" : window.location.href;

  const sheetBody = (() => {
    if (page?.kind === "track") {
      const t = doc.tracks.find((x) => x.id === page.id);
      if (!t) return null;
      const f = fb("track", t.id);
      return (
        <div className="px-4 py-3">
          <div className="text-xs text-bone-dim">{trackMeta(t)}</div>
          <div className="mt-3 flex items-center gap-2">
            {voteButtons("track", t.id)}
            <span className="ml-auto whitespace-nowrap text-xs text-bone-dim">
              {tallyLabel(f)}
            </span>
          </div>
          {t.description && (
            <p className="mt-3 whitespace-pre-line text-xs text-bone-dim/90">
              {t.description}
            </p>
          )}
          <div className="mt-3">{comments(f)}</div>
          {commentBox("track", t.id)}
          <button
            onClick={() => {
              zoomToTrack(t);
              closeSheet();
            }}
            className="mt-3 w-full rounded border border-line px-3 py-2 text-xs uppercase tracking-wider text-bone"
          >
            Show on map
          </button>
        </div>
      );
    }
    if (page?.kind === "option") {
      if (page.which === "basemap")
        return optionList(
          (Object.keys(BASEMAP_LABELS) as BasemapId[]).map(
            (k) => [k, BASEMAP_LABELS[k]] as [BasemapId, string],
          ),
          basemap,
          setBasemap,
        );
      if (page.which === "detail")
        return optionList(
          (Object.keys(DETAIL_LABELS) as DetailLevel[]).map(
            (k) => [k, DETAIL_LABELS[k]] as [DetailLevel, string],
          ),
          detail,
          setDetail,
        );
      return optionList(
        [
          ["original", "Original colours"],
          ["votes", "Votes"],
        ] as [ColorBy, string][],
        colorBy,
        setColorBy,
      );
    }
    if (page?.kind === "group") {
      const list = groupTracks(page.which);
      if (!list.length)
        return <p className="px-4 py-4 text-sm text-bone-dim">Nothing here yet.</p>;
      return (
        <>
          {list.map((t) =>
            trackRow(t, () => setPages([{ kind: "track", id: t.id }]), false),
          )}
        </>
      );
    }
    if (tab === "tracks")
      return (
        <>
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs text-bone-dim">
            sort {sortSelect}
          </div>
          {tracksInOrder.map((t) =>
            trackRow(t, () => pushPage({ kind: "track", id: t.id }), false),
          )}
          {markRows}
        </>
      );
    if (tab === "map")
      return (
        <>
          {sheetRow("Base map", <>{BASEMAP_LABELS[basemap]} {chevron}</>, () =>
            pushPage({ kind: "option", which: "basemap" }),
          )}
          {basemap === "dingo" &&
            sheetRow("Detail", <>{DETAIL_LABELS[detail]} {chevron}</>, () =>
              pushPage({ kind: "option", which: "detail" }),
            )}
          {sheetRow(
            "Colours",
            <>{colorBy === "votes" ? "Votes" : "Original"} {chevron}</>,
            () => pushPage({ kind: "option", which: "colours" }),
          )}
          {(doc.pois?.length ?? 0) > 0 &&
            switchRow("POIs", showPois, () => setShowPois((v) => !v))}
          {switchRow("Closures", showClosures, () => setShowClosures((v) => !v))}
          <div className="px-4 py-3 text-xs text-bone-dim">{legendBody}</div>
        </>
      );
    if (tab === "trip")
      return (
        <>
          {/* The page's title bar is hidden on a short screen, so the trip's
              own name belongs here. */}
          <div className="border-b border-line px-4 py-3 text-sm font-semibold text-bone">
            {doc.name}
          </div>
          {sheetRow(
            "Liked",
            <>
              <span className="text-[var(--dd-status-ok)]">{rollup.liked}</span>
              {rollup.liked ? ` · ${rollup.likedKm.toLocaleString()} km` : ""} {chevron}
            </>,
            () => pushPage({ kind: "group", which: "liked" }),
          )}
          {sheetRow("Undecided", <>{rollup.undecided} {chevron}</>, () =>
            pushPage({ kind: "group", which: "undecided" }),
          )}
          {sheetRow(
            "Vetoed",
            <>
              <span className="text-[#c96a5a]">{rollup.vetoed}</span> {chevron}
            </>,
            () => pushPage({ kind: "group", which: "vetoed" }),
          )}
          <div className="px-4 py-3 text-xs text-bone-dim">
            {doc.tracks.length} tracks in this trip.
          </div>
        </>
      );
    return (
      <>
        {sheetRow("Your name", me ?? "not set", () => {
          setNameDraft(me ?? "");
          setAskName(true);
        })}
        {sheetRow("Your votes", `${myVotes}`)}
        {sheetRow(copied ? "Link copied" : "Copy share link", null, () => {
          navigator.clipboard?.writeText(shareUrl).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false),
          );
        })}
        {selectedIds.length > 0 &&
          sheetRow(`Clear ${selectedIds.length} selected`, null, () =>
            setSelection([]),
          )}
        <p className="px-4 py-3 text-xs text-bone-dim">
          Your name is remembered on this device only. Anyone with the link can
          vote.
        </p>
      </>
    );
  })();

  const sheetTitle =
    page?.kind === "track"
      ? (doc.tracks.find((x) => x.id === page.id)?.name ?? "Track")
      : page?.kind === "option"
        ? page.which === "basemap"
          ? "Base map"
          : page.which === "detail"
            ? "Detail"
            : "Colours"
        : page?.kind === "group"
          ? GROUP_LABELS[page.which]
          : (TABS.find((t) => t.id === tab)?.label ?? "");

  const navEl = (
    <nav
      aria-label="Plan sections"
      className={`flex shrink-0 bg-ink ${
        landscape
          ? "w-14 flex-col border-r border-line"
          : "h-14 border-t border-line"
      }`}
      style={{ paddingBottom: landscape ? 0 : "env(safe-area-inset-bottom)" }}
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => {
            setPages([]);
            setTab(tab === t.id ? null : t.id);
          }}
          aria-pressed={tab === t.id}
          className={`flex flex-1 flex-col items-center justify-center gap-1 text-[10px] uppercase tracking-wider transition-colors ${
            tab === t.id ? "text-clay-hot" : "text-bone-dim"
          }`}
        >
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true">
            <path
              d={t.d}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t.label}
        </button>
      ))}
    </nav>
  );

  return (
    // --dd-font: the site loads Barlow through next/font under a hashed
    // family name, so core/ui's literal 'Barlow' would miss it.
    <div
      className={`flex min-h-0 flex-1 ${
        phone ? (landscape ? "flex-row" : "flex-col") : "flex-col md:flex-row"
      }`}
      style={{ "--dd-font": "var(--font-body), sans-serif" } as CSSProperties}
    >
      {phone && landscape && navEl}
      {!phone && (
        <div className="order-2 h-1/2 w-full overflow-y-auto border-t border-line md:order-1 md:h-full md:w-[400px] md:border-r md:border-t-0">
          <div className="border-b border-line px-4 py-3 text-sm text-bone-dim">
            <div>
              <span className="text-[var(--dd-status-ok)]">{rollup.liked} liked</span>
              {rollup.liked ? ` (${rollup.likedKm.toLocaleString()} km)` : ""} ·{" "}
              <span className="text-[#c96a5a]">{rollup.vetoed} vetoed</span> ·{" "}
              {rollup.undecided} undecided
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              sort
              {sortSelect}
              <span className="ml-auto">{nameButton}</span>
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
              <div className="mt-2 text-xs text-[var(--dd-alert-bad)]">{postError}</div>
            )}
          </div>
          {tracksInOrder.map((t) => trackRow(t, () => toggleTrack(t, true), true))}
          {markRows}
        </div>
      )}
      <div
        className={
          phone
            ? // The zoom buttons sit in the same corner as the rollup and,
              // in landscape, behind the sheet. Pinch does the job here.
              "relative min-h-0 flex-1 [&_.maplibregl-ctrl-top-left]:hidden"
            : "relative order-1 h-1/2 flex-1 md:order-2 md:h-full"
        }
      >
        {/* maplibre-gl.css loads at runtime after the app styles and its
            .maplibregl-map { position: relative } outranks Tailwind's
            .absolute by order, collapsing the container to height 0 —
            the inline style keeps the map filling its parent. */}
        <div ref={mapDiv} className="absolute inset-0" style={{ position: "absolute" }} />

        {/* The rollup is the one number always wanted, so on a phone it stays
            on the map rather than hiding in the Trip tab. */}
        {phone && (
          <div className="absolute right-3 top-3 z-10 rounded border border-line bg-ink/85 px-2.5 py-1.5 text-[11px] text-bone-dim">
            <span className="text-[var(--dd-status-ok)]">{rollup.liked} liked</span> ·{" "}
            <span className="text-[#c96a5a]">{rollup.vetoed} vetoed</span> ·{" "}
            {rollup.undecided} undecided
          </div>
        )}
        {phone && postError && (
          <div className="absolute left-3 right-3 top-12 z-10 rounded border border-line bg-ink/90 px-2.5 py-1.5 text-xs text-[var(--dd-alert-bad)]">
            {postError}
          </div>
        )}

        {!phone && (
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
        )}
        {!phone && (
          <div className="absolute bottom-6 left-3 z-10 max-w-[60%] rounded border border-line bg-ink/90 px-3 py-1.5 text-xs text-bone-dim">
            {legendBody}
          </div>
        )}

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
          const meta = pinMeta(p.category);
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
                <PinBadge category={p.category ?? "poi"} size={20} />
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

        {/* Level 2 and 3 both live in the shared .dd-sheet, which docks
            bottom in portrait and left in landscape (core/ui/chrome.css). */}
        {phone && tab && (
          <div className="dd-sheet z-30" data-testid="plan-sheet">
            <div className="dd-sheet-handle" />
            <header>
              <span className="flex min-w-0 items-center gap-2">
                {pages.length > 0 && (
                  <button
                    onClick={() => setPages((s) => s.slice(0, -1))}
                    aria-label="Back"
                    className="text-bone-dim"
                  >
                    ‹
                  </button>
                )}
                <span className="truncate">{sheetTitle}</span>
              </span>
              <button onClick={closeSheet} aria-label="Close" className="text-bone-dim">
                ×
              </button>
            </header>
            <div className="dd-sheet-body">{sheetBody}</div>
          </div>
        )}
      </div>
      {phone && !landscape && navEl}

      {askName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70">
          <div className="dd-dialog w-80 shadow-xl">
            <h2>Who are you?</h2>
            <p>
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
              className="w-full rounded border border-line bg-ink px-3 py-2 text-sm text-bone"
            />
            <footer>
              <button onClick={() => setAskName(false)}>Cancel</button>
              <button onClick={saveName} className="dd-primary">
                Start voting
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
