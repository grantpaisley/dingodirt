"use client";

// Planning-mode share page: all candidate tracks on one interactive map
// with a track list alongside (docs/plans/2026-08-07-planning-mode-design.md).
// Read-only for now — votes are the next step; the layout already leaves
// room for the vote widgets on each tile.

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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

/** Flat coordinate list for bounds math, either geometry flavour. */
function coordsOf(g: PlanTrack["geometry"]): [number, number][] {
  return (
    g.type === "MultiLineString"
      ? (g.coordinates as [number, number][][]).flat()
      : (g.coordinates as [number, number][])
  );
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

// Basemap sources. tiles.dingodirt.com (shared R2 archive) isn't deployed
// yet; until it is, topo = OSM raster. Sources are swappable in one place.
const BASEMAPS: Record<string, { label: string; tiles: string[]; attribution: string; maxzoom: number }> = {
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

export default function PlanView({ doc }: { doc: PlanDoc }) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const [basemap, setBasemap] = useState<keyof typeof BASEMAPS>("topo");

  const totalKm = useMemo(
    () => Math.round(doc.tracks.reduce((s, t) => s + (t.km ?? 0), 0)),
    [doc.tracks],
  );

  const featureCollection = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: doc.tracks.map((t) => ({
        type: "Feature" as const,
        properties: { id: t.id },
        geometry: t.geometry,
      })),
    }),
    [doc.tracks],
  );

  // Selection must be unmistakable: ~3x width over a wide casing, full
  // opacity, drawn above the unselected tracks.
  const applySelection = (map: maplibregl.Map, id: string | null) => {
    map.setFilter("track-active-casing", ["==", ["get", "id"], id ?? ""]);
    map.setFilter("track-active", ["==", ["get", "id"], id ?? ""]);
  };

  const focusTrack = (t: PlanTrack) => {
    setActiveId(t.id);
    const map = mapRef.current;
    if (!map) return;
    applySelection(map, t.id);
    const cs = coordsOf(t.geometry);
    if (!cs.length) return;
    const bounds = cs.reduce(
      (b, c) => b.extend(c as [number, number]),
      new maplibregl.LngLatBounds(cs[0], cs[0]),
    );
    map.fitBounds(bounds, { padding: 60, maxZoom: 11 });
    document
      .getElementById(`plan-track-${t.id}`)
      ?.scrollIntoView({ block: "nearest" });
  };
  activeRef.current = activeId;

  useEffect(() => {
    if (!mapDiv.current) return;
    const source = BASEMAPS[basemap];
    const map = new maplibregl.Map({
      container: mapDiv.current,
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
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    new ResizeObserver(() => map.resize()).observe(mapDiv.current);

    map.on("load", () => {
      map.addSource("tracks", {
        type: "geojson",
        data: featureCollection as GeoJSON.FeatureCollection,
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
        paint: { "line-color": TRACK_COLOR, "line-width": 2, "line-opacity": 0.9 },
      });
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

      // Whole-plan overview once geometry is in.
      const all = doc.tracks.flatMap((t) => coordsOf(t.geometry));
      if (all.length) {
        const bounds = all.reduce(
          (b, c) => b.extend(c as [number, number]),
          new maplibregl.LngLatBounds(all[0], all[0]),
        );
        map.fitBounds(bounds, { padding: 40 });
      }

      const clickTrack = (e: maplibregl.MapLayerMouseEvent) => {
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
          "font-size:20px;cursor:default;text-shadow:0 1px 3px rgba(0,0,0,.6)";
        el.title = m.name;
        new maplibregl.Marker({ element: el }).setLngLat([m.lon, m.lat]).addTo(map);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Recreate the map when the basemap changes — raster style swap is
    // cheaper to express as a rebuild and keeps the layer setup in one place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, featureCollection]);

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-[480px] flex-col md:flex-row">
      <div className="order-2 h-1/2 w-full overflow-y-auto border-t border-line md:order-1 md:h-full md:w-[380px] md:border-r md:border-t-0">
        <div className="border-b border-line px-4 py-3 text-sm text-bone-dim">
          <span className="text-bone">{doc.tracks.length}</span> candidate tracks ·{" "}
          <span className="text-bone">{totalKm.toLocaleString()}</span> km total
        </div>
        {doc.tracks.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              id={`plan-track-${t.id}`}
              onClick={() => focusTrack(t)}
              className={`block w-full border-b border-line px-4 py-3 text-left transition-colors hover:bg-ink-2/60 ${
                active ? "bg-ink-2 shadow-[inset_3px_0_0_#e07a3f]" : ""
              }`}
            >
              <div className="text-sm font-semibold text-bone">{t.name}</div>
              <div className="mt-0.5 text-xs text-bone-dim">
                {t.km ? `${t.km} km` : ""}
                {t.region || t.state ? ` · ${t.region || t.state}` : ""}
                {t.grade ? ` · ${t.grade}` : ""}
              </div>
              {t.description && (
                <p
                  className={`mt-1 text-xs text-bone-dim/90 ${
                    active ? "whitespace-pre-line" : "line-clamp-2"
                  }`}
                >
                  {t.description}
                </p>
              )}
            </button>
          );
        })}
        {(doc.marks?.length ?? 0) > 0 && (
          <>
            <div className="border-b border-line px-4 py-2 text-xs uppercase tracking-wider text-bone-dim">
              Stops & accommodation
            </div>
            {doc.marks!.map((m) => (
              <button
                key={m.id}
                onClick={() =>
                  mapRef.current?.flyTo({ center: [m.lon, m.lat], zoom: 9 })
                }
                className="block w-full border-b border-line px-4 py-2.5 text-left text-sm text-bone transition-colors hover:bg-ink-2/60"
              >
                <span className="mr-2">{m.icon || "⛺"}</span>
                {m.name}
              </button>
            ))}
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
      </div>
    </div>
  );
}
