"use client";

// Planning-mode share page: all candidate tracks on one interactive map,
// with Yes/Maybe/No voting per track and mark
// (docs/plans/2026-08-07-planning-mode-design.md). Identity is a
// self-reported name in localStorage; the share link is the access control.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as maplibreNs from "maplibre-gl";

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

export interface PlanDoc {
  name: string;
  description?: string;
  tracks: PlanTrack[];
  marks?: PlanMark[];
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

// Basemap sources. tiles.dingodirt.com (shared R2 archive) isn't deployed
// yet; until it is, topo = OSM raster. Sources are swappable in one place.
const BASEMAPS: Record<
  string,
  { label: string; tiles: string[]; attribution: string; maxzoom: number }
> = {
  topo: {
    label: "Topo",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap",
    maxzoom: 19,
  },
  satellite: {
    label: "Satellite",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Esri, Maxar, Earthstar Geographics",
    maxzoom: 18,
  },
};

const TRACK_COLOR = "#e07a3f"; // clay-ish, matches the site accent
const VERDICT_COLORS: Record<string, string> = {
  yes: "#57a557",
  maybe: "#c9a227",
  no: "#8a4a42",
  none: "#8a8177",
};

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

export default function PlanView({
  doc,
  token,
}: {
  doc: PlanDoc;
  token: string;
}) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibreNs.Map | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const [basemap, setBasemap] = useState<keyof typeof BASEMAPS>("topo");
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
  activeRef.current = activeId;

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

  // ---- map ----
  const buildFC = useCallback(
    (f: Feedback) => ({
      type: "FeatureCollection" as const,
      features: doc.tracks.map((t) => ({
        type: "Feature" as const,
        properties: { id: t.id, verdict: verdict(f[`track:${t.id}`]) },
        geometry: t.geometry,
      })),
    }),
    [doc.tracks],
  );

  const applySelection = (map: maplibreNs.Map, id: string | null) => {
    map.setFilter("track-active-casing", ["==", ["get", "id"], id ?? ""]);
    map.setFilter("track-active", ["==", ["get", "id"], id ?? ""]);
  };

  const focusTrack = (t: PlanTrack) => {
    setActiveId(t.id);
    const map = mapRef.current;
    const ml = window.maplibregl;
    if (!map || !ml) return;
    applySelection(map, t.id);
    const cs = coordsOf(t.geometry);
    if (!cs.length) return;
    const bounds = cs.reduce(
      (b, c) => b.extend(c as [number, number]),
      new ml.LngLatBounds(cs[0], cs[0]),
    );
    map.fitBounds(bounds, { padding: 60, maxZoom: 11 });
    document
      .getElementById(`plan-track-${t.id}`)
      ?.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    const container = mapDiv.current;
    if (!container) return;
    let cancelled = false;
    let map: maplibreNs.Map | null = null;
    loadMaplibre().then((ml) => {
      if (cancelled) return;
      map = createMap(ml, container);
    });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // Recreated on basemap switch; layer setup stays in one place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  const createMap = (ml: MaplibreNS, container: HTMLDivElement) => {
    const source = BASEMAPS[basemap];
    const map = new ml.Map({
      container,
      style: {
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
      },
      center: [134, -26],
      zoom: 3.5,
    });
    mapRef.current = map;
    // Debug handle + surfaced errors, mirroring Plan's __dingoMap convention.
    (window as unknown as Record<string, unknown>).__planMap = map;
    map.on("error", (e) => console.error("[plan-map]", e.error ?? e));
    map.addControl(new ml.NavigationControl(), "top-left");
    new ResizeObserver(() => map.resize()).observe(container);

    const verdictColor: maplibreNs.ExpressionSpecification = [
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

    map.on("load", () => {
      map.addSource("tracks", {
        type: "geojson",
        data: buildFC(feedbackRef.current) as GeoJSON.FeatureCollection,
      });
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
          "line-color": verdictColor,
          "line-width": 2.2,
          "line-opacity": [
            "match",
            ["get", "verdict"],
            "no",
            0.45,
            0.92,
          ] as unknown as maplibreNs.ExpressionSpecification,
        },
      });
      // Selection must be unmistakable: ~3x width over a wide casing.
      map.addLayer({
        id: "track-active-casing",
        type: "line",
        source: "tracks",
        filter: ["==", ["get", "id"], ""],
        paint: { "line-color": "#fffbf2", "line-width": 13, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "track-active",
        type: "line",
        source: "tracks",
        filter: ["==", ["get", "id"], ""],
        paint: { "line-color": TRACK_COLOR, "line-width": 9, "line-opacity": 1 },
      });
      applySelection(map, activeRef.current);

      const all = doc.tracks.flatMap((t) => coordsOf(t.geometry));
      if (all.length) {
        const bounds = all.reduce(
          (b, c) => b.extend(c as [number, number]),
          new ml.LngLatBounds(all[0], all[0]),
        );
        map.fitBounds(bounds, { padding: 40 });
      }

      const clickTrack = (e: maplibreNs.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        const t = doc.tracks.find((x) => x.id === id);
        if (t) focusTrack(t);
      };
      map.on("click", "tracks", clickTrack);
      map.on("click", "track-active", clickTrack);
      map.on("mouseenter", "tracks", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "tracks", () => {
        map.getCanvas().style.cursor = "";
      });

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
          {postError && (
            <div className="mt-2 text-xs text-[#c96a5a]">{postError}</div>
          )}
        </div>
        {tracksInOrder.map((t) => {
          const active = t.id === activeId;
          const f = fb("track", t.id);
          return (
            <div
              key={t.id}
              id={`plan-track-${t.id}`}
              onClick={() => focusTrack(t)}
              className={`cursor-pointer border-b border-line px-4 py-3 transition-colors hover:bg-ink-2/60 ${
                active ? "bg-ink-2 shadow-[inset_3px_0_0_#e07a3f]" : ""
              }`}
            >
              <div className="text-sm font-semibold text-bone">{t.name}</div>
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
        <div ref={mapDiv} className="absolute inset-0" />
        <div className="absolute right-3 top-3 z-10 flex overflow-hidden rounded border border-line bg-ink/90 text-xs">
          {Object.entries(BASEMAPS).map(([key, b]) => (
            <button
              key={key}
              onClick={() => setBasemap(key)}
              className={`px-3 py-1.5 uppercase tracking-wider transition-colors ${
                basemap === key
                  ? "bg-clay text-ink"
                  : "text-bone-dim hover:text-bone"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="absolute bottom-6 left-3 z-10 rounded border border-line bg-ink/90 px-3 py-1.5 text-xs text-bone-dim">
          <span className="mr-3"><i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: VERDICT_COLORS.yes }} />liked</span>
          <span className="mr-3"><i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: VERDICT_COLORS.maybe }} />maybe</span>
          <span className="mr-3"><i className="mr-1 inline-block h-1 w-4 rounded opacity-50" style={{ background: VERDICT_COLORS.no }} />vetoed</span>
          <span><i className="mr-1 inline-block h-1 w-4 rounded" style={{ background: VERDICT_COLORS.none }} />unvoted</span>
        </div>
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
