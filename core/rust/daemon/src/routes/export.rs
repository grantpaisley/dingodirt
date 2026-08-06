//! Export API: named destinations (synced device folders) + bundle export.
//!
//! `POST /api/export` takes the web UI's basket (explicit ride ids) and either
//! writes a bundle folder into a configured destination (Syncthing does the
//! rest) or streams the bundle back as a zip download — the path that will
//! survive a hosted deployment where the server can't see the user's disk.

use axum::body::Body;
use axum::http::{StatusCode, header};
use axum::response::Response;
use axum::{
    Json, Router,
    extract::{Extension, Path as AxumPath, Query},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use dingo_export::heat_tiles::{HeatScope, HeatTilesOptions, build_heat_mbtiles};
use dingo_export::{
    BundleOptions, Layout, Manifest, Profile, build_bundle, build_ride_gpx, sanitize,
    sanitize_filename,
};

pub(crate) type ApiError = (StatusCode, String);

pub(crate) fn internal(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

pub(crate) fn bad_request(msg: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, msg.into())
}

pub fn routes() -> Router {
    Router::new()
        .route("/", post(export_bundle))
        .route("/dingonav", post(export_dingonav))
        .route("/estimate", post(estimate_export))
        .route("/heatmap-tiles", post(export_heatmap_tiles))
        .route("/share", post(export_share))
        .route("/shares", get(list_shares))
        .route("/destinations", get(list_destinations).post(create_destination))
        .route("/destinations/{id}", axum::routing::delete(delete_destination))
}

// ---- Destinations ----

#[derive(Debug, Serialize)]
struct Destination {
    id: Uuid,
    name: String,
    path: String,
    profile: String,
    layout: String,
}

async fn list_destinations(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<Vec<Destination>>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, path, profile, layout FROM export_destinations ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|r| Destination {
                id: r.get("id"),
                name: r.get("name"),
                path: r.get("path"),
                profile: r.get("profile"),
                layout: r.get("layout"),
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
struct NewDestination {
    name: String,
    path: String,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    layout: Option<String>,
}

async fn create_destination(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<NewDestination>,
) -> Result<Json<Destination>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("destination name must not be empty"));
    }
    let profile = body.profile.as_deref().unwrap_or("generic");
    if Profile::parse(profile).is_none() {
        return Err(bad_request(format!(
            "unknown profile '{profile}' (osmand | locus | dmd2 | generic)"
        )));
    }
    let layout = body.layout.as_deref().unwrap_or("flat");
    if Layout::parse(layout).is_none() {
        return Err(bad_request(format!("unknown layout '{layout}' (flat | tree)")));
    }
    // Expand a leading ~ so paths can be written the way people type them.
    let path = expand_home(body.path.trim());
    if path.as_os_str().is_empty() {
        return Err(bad_request("destination path must not be empty"));
    }

    let row = sqlx::query(
        r#"
        INSERT INTO export_destinations (name, path, profile, layout)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO UPDATE
            SET path = EXCLUDED.path, profile = EXCLUDED.profile,
                layout = EXCLUDED.layout
        RETURNING id, name, path, profile, layout
        "#,
    )
    .bind(name)
    .bind(path.to_string_lossy().as_ref())
    .bind(profile)
    .bind(layout)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(Json(Destination {
        id: row.get("id"),
        name: row.get("name"),
        path: row.get("path"),
        profile: row.get("profile"),
        layout: row.get("layout"),
    }))
}

async fn delete_destination(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let res = sqlx::query("DELETE FROM export_destinations WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(internal)?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no destination {id}")));
    }
    Ok(Json(serde_json::json!({ "deleted": id })))
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

// ---- Bundle export ----

#[derive(Debug, Deserialize)]
struct ExportRequest {
    ride_ids: Vec<Uuid>,
    /// Write the bundle into this configured destination…
    destination_id: Option<Uuid>,
    /// …or stream it back as a zip (exactly one of the two must be chosen)
    #[serde(default)]
    download: bool,
    /// Bundle (folder / zip file) name
    name: String,
    #[serde(default = "default_true")]
    include_tracks: bool,
    #[serde(default = "default_true")]
    include_heatmap: bool,
    /// Remove privacy-zone points (Arcadia). Default on; the export dialog's
    /// checkbox can turn it off for a complete personal copy.
    #[serde(default = "default_true")]
    privacy: bool,
}

pub(crate) fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
struct ExportResponse {
    bundle_dir: String,
    manifest: Manifest,
}

async fn export_bundle(
    Extension(pool): Extension<PgPool>,
    Query(_q): Query<serde_json::Value>,
    Json(body): Json<ExportRequest>,
) -> Result<Response, ApiError> {
    if body.ride_ids.is_empty() {
        return Err(bad_request("ride_ids must not be empty"));
    }
    if !body.include_tracks && !body.include_heatmap {
        return Err(bad_request("nothing to export — enable tracks and/or heatmap"));
    }
    let bundle_name = sanitize(body.name.trim());
    if bundle_name == "Unknown" && body.name.trim().is_empty() {
        return Err(bad_request("bundle name must not be empty"));
    }
    if body.download == body.destination_id.is_some() {
        return Err(bad_request(
            "choose exactly one of destination_id or download: true",
        ));
    }

    if let Some(dest_id) = body.destination_id {
        // Destination mode: validate the folder BEFORE building anything.
        let row = sqlx::query("SELECT path, profile, layout FROM export_destinations WHERE id = $1")
            .bind(dest_id)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?
            .ok_or((StatusCode::NOT_FOUND, format!("no destination {dest_id}")))?;
        let dest_path = PathBuf::from(row.get::<String, _>("path"));
        let profile = Profile::parse(&row.get::<String, _>("profile")).unwrap_or(Profile::Generic);
        let layout = Layout::parse(&row.get::<String, _>("layout")).unwrap_or(Layout::Flat);

        if !dest_path.is_dir() {
            return Err(bad_request(format!(
                "destination folder does not exist: {} — is the sync folder mounted?",
                dest_path.display()
            )));
        }
        let probe = dest_path.join(".dingo-write-probe");
        std::fs::write(&probe, b"ok")
            .map_err(|e| bad_request(format!("destination not writable: {e}")))?;
        let _ = std::fs::remove_file(&probe);

        let bundle_dir = dest_path.join(&bundle_name);
        let manifest = run_build(&pool, &body, &bundle_dir, profile, layout).await?;
        let resp = ExportResponse {
            bundle_dir: bundle_dir.to_string_lossy().into_owned(),
            manifest,
        };
        return Ok(Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&resp).map_err(internal)?))
            .map_err(internal)?);
    }

    // Download mode: build fully in a scratch dir, then zip and stream. A
    // failure mid-build returns an error, never a truncated zip.
    let scratch = std::env::temp_dir().join(format!("dingo-export-{}", Uuid::new_v4()));
    let bundle_dir = scratch.join(&bundle_name);
    let manifest = run_build(&pool, &body, &bundle_dir, Profile::Generic, Layout::Flat).await;
    let result = match manifest {
        Ok(m) => zip_dir(&bundle_dir, &bundle_name).map(|z| (m, z)).map_err(internal),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(&scratch);
    let (manifest, zip_bytes) = result?;

    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}.zip\"", bundle_name.replace('"', "")),
        )
        .header("x-dingo-manifest", urlencode_manifest(&manifest))
        .body(Body::from(zip_bytes))
        .map_err(internal)?)
}

// ---- DingoNav bundle (v2: a .dingonav zip) ----

#[derive(Debug, Deserialize)]
struct DingoNavRequest {
    ride_ids: Vec<Uuid>,
    name: String,
    #[serde(default = "default_true")]
    include_tracks: bool,
    #[serde(default = "default_true")]
    include_heatmap: bool,
    /// Bake Strava global-heatmap raster tiles for the ride corridor (needs the
    /// daemon to be Strava-connected; degrades to zero tiles otherwise).
    #[serde(default)]
    include_strava: bool,
    /// Cut a PMTiles basemap extract for the ride corridor (needs
    /// DINGO_BASEMAP_PMTILES + the pmtiles CLI; degrades to none otherwise).
    #[serde(default)]
    include_basemap: bool,
    /// Bake ESRI World Imagery satellite raster tiles for the ride corridor
    /// (fetched live; degrades to zero tiles offline).
    #[serde(default)]
    include_satellite: bool,
    /// Cut a terrarium-DEM hillshade PMTiles extract for the corridor (needs
    /// DINGO_HILLSHADE_PMTILES + the pmtiles CLI; degrades to none otherwise).
    #[serde(default)]
    include_hillshade: bool,
    /// Deepest satellite zoom to bake (clamped to [SAT_ZMIN, SAT_ZMAX]); higher
    /// = sharper but larger. Absent = SAT_ZMAX.
    #[serde(default)]
    satellite_zoom: Option<u32>,
    /// The web UI's filter-panel state; when present the surrounding heatmap
    /// only bakes rides the on-screen heatmap shows (MapView applies these
    /// same predicates client-side). Absent = everything, the old behavior.
    #[serde(default)]
    heatmap_filters: Option<HeatmapFilters>,
    /// Per-layer coverage shape (corridor vs rect). Absent = all corridor.
    #[serde(default)]
    coverage: LayerCoverage,
    /// Remove privacy-zone points (default on).
    #[serde(default = "default_true")]
    privacy: bool,
}

/// Coverage shape for a bundle map layer: `corridor` follows the selected
/// tracks (ST_Buffer polygon, the default); `rect` is the legacy behaviour —
/// the selection's whole bounding box. The name "detail" is reserved for a
/// future turn-point mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Coverage {
    #[default]
    Corridor,
    Rect,
}

/// Per-layer coverage modes; missing keys default to corridor, so a NULL /
/// absent blob means "everything corridor-shaped".
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub(crate) struct LayerCoverage {
    #[serde(default)]
    pub(crate) heatmap: Coverage,
    #[serde(default)]
    pub(crate) basemap: Coverage,
    #[serde(default)]
    pub(crate) satellite: Coverage,
    #[serde(default)]
    pub(crate) strava: Coverage,
    /// Reach of the zoomed-out heat lines. Lives in the same blob as the
    /// per-layer shapes so pack publishes round-trip it through packs.coverage
    /// with no migration; a missing key means local.
    #[serde(default)]
    pub(crate) heat_overview: HeatOverview,
    #[serde(default)]
    pub(crate) hillshade: Coverage,
}

impl LayerCoverage {
    /// Any enabled layer that would need the corridor polygon built?
    fn wants_corridor(&self, opts: &DingoNavOpts) -> bool {
        (opts.include_heatmap && self.heatmap == Coverage::Corridor)
            || (opts.include_basemap && self.basemap == Coverage::Corridor)
            || (opts.include_satellite && self.satellite == Coverage::Corridor)
            || (opts.include_strava && self.strava == Coverage::Corridor)
            || (opts.include_hillshade && self.hillshade == Coverage::Corridor)
    }
}

/// How far the ZOOMED-OUT heat lines reach, beyond the corridor-clipped detail
/// heat. `Region` was the original (and only) behaviour and it put every ride
/// in the state on the device — riding out of Sydney you'd see Broken Hill and
/// the Gold Coast when you zoomed out. `Local` keeps the useful part of that
/// (what else is around here) without the noise or the ~2 MB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum HeatOverview {
    /// No lines beyond the corridor at all.
    None,
    /// Rides within OVERVIEW_HEAT_RADIUS_M of the corridor.
    #[default]
    Local,
    /// Rides across the whole overview region (the containing area, e.g. NSW).
    Region,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct HeatmapFilters {
    /// Enabled track classes: own / other / plan
    classes: Vec<String>,
    /// Enabled ride modes; a NULL mode counts as 'other', as in the web UI
    modes: Vec<String>,
    #[serde(default)]
    require_hr: bool,
    #[serde(default)]
    require_speed: bool,
    /// YYYY-MM-DD, inclusive, compared on the UTC date like the web UI
    date_from: Option<String>,
    date_to: Option<String>,
}

#[derive(Debug, Serialize)]
struct DingoNavTrack {
    name: String,
    gpx: String,
    /// Stable identity across plan revisions: DingoNav keys the track (and the
    /// rider's cue edits) on this instead of a content hash when present.
    #[serde(rename = "rideId")]
    ride_id: Uuid,
}

/// Corridor build knobs. The true corridor is a 1.5 km ST_Buffer around the
/// selected tracks; rect mode keeps the legacy bbox + ≈1.5 km (0.015°) margin.
/// Strava tiles z11–15, capped.
const CORRIDOR_BUFFER_M: f64 = 1500.0;
const CORRIDOR_BUFFER_DEG: f64 = 0.015;
const STRAVA_ZMIN: u32 = 11;
const STRAVA_ZMAX: u32 = 15;
const STRAVA_TILE_CAP: usize = 600;

/// Overview coverage knobs: whole-region context at low zooms so a pack isn't
/// blank zoomed out on the device. The region is the top-level area containing
/// the selection (fallback: the DINGO_OVERVIEW_BBOX env, e.g. NSW), unioned
/// with the selection envelope so an out-of-area ride never loses low-zoom
/// coverage under itself. Basemap gets region z0–7 + a local z8–10 band merged
/// with corridor z11–15 (see below); Strava gets coarse region z8–10;
/// satellite gets a z0–11 pyramid over the selection rect (below,
/// OVERVIEW_SAT_*); hillshade gets none.
///
/// Region-wide vector tiles get expensive fast — NSW measures 1.7 MB to z7,
/// 4 MB to z8, 9.6 MB to z9, 21 MB to z10 — so the region only carries the
/// genuinely zoomed-out band and a local rect covers z8–10 for ~1 MB. The
/// three ranges must stay contiguous (region ≤ z7, local z8–10, corridor
/// z11–15): a gap is a zoom level where the device shows no map at all.
const OVERVIEW_BASEMAP_MAXZOOM: u32 = 7;
/// Local mid-zoom basemap band: the selection rect plus a margin wide enough
/// to show where the ride sits in its district (~33 km).
const LOCAL_BASEMAP_ZMIN: u32 = OVERVIEW_BASEMAP_MAXZOOM + 1;
const LOCAL_BASEMAP_ZMAX: u32 = 10;
const LOCAL_BASEMAP_MARGIN_DEG: f64 = 0.3;
const OVERVIEW_STRAVA_ZMIN: u32 = 8;
const OVERVIEW_STRAVA_ZMAX: u32 = 10;
const OVERVIEW_STRAVA_CAP: usize = 250;
/// Most-recent-first cap on region-wide simplified own-heat lines.
const OVERVIEW_HEAT_FEATURE_CAP: i64 = 2000;
/// How far [`HeatOverview::Local`] reaches past the corridor: far enough to
/// show the district a ride sits in (the next valley, the parallel fire trail
/// network) without dragging in the whole state.
const OVERVIEW_HEAT_RADIUS_M: f64 = 50_000.0;
/// …and a byte budget on top of it, because a feature count doesn't bound
/// anything: 2000 NSW rides measured 38 MB of GeoJSON, and simplification
/// barely dented it (41 MB even at a 5 km tolerance) because a handful of
/// imported track networks carried most of the points. Lines are taken
/// most-recent-first until the budget runs out, skipping any single feature
/// over the per-feature cap.
const OVERVIEW_HEAT_FEATURE_MAX_BYTES: i64 = 60_000;
const OVERVIEW_HEAT_TOTAL_BYTES: i64 = 2_000_000;

/// Satellite (ESRI World Imagery) corridor knobs — deeper than Strava (imagery
/// stays legible zoomed in), capped so a wide selection can't fire thousands of
/// fetches.
const SAT_ZMIN: u32 = 12;
const SAT_ZMAX: u32 = 16;
const SAT_TILE_CAP: usize = 800;
/// Zoomed-out satellite: a full z0–(SAT_ZMIN-1) pyramid over the selection
/// rect — NOT corridor-clipped — so the Sat style still shows imagery when the
/// rider zooms out to frame the whole track. The pyramid must stay continuous
/// up to SAT_ZMIN-1: trimming its top (the cap drops deepest zooms first)
/// leaves a blank display band between the overview and the corridor tiles,
/// so the cap is sized for multi-day selections (an 820 km two-ride pack
/// needs ~139 tiles, ~2 MB) and only bites on continent-scale ones.
const OVERVIEW_SAT_ZMAX: u32 = SAT_ZMIN - 1;
const OVERVIEW_SAT_CAP: usize = 250;
/// ESRI World Imagery attribution — required by their terms; baked into the
/// bundle so DingoNav can surface it.
const ESRI_ATTRIBUTION: &str = "Esri, Maxar, Earthstar Geographics, and the GIS User Community";

/// Rough per-tile sizes for pre-build MB estimates. Raster tiles are ~fixed;
/// vector/DEM extracts scale with covered tiles. Deliberately conservative — the
/// UI labels these as estimates and the manifest reports the real bytes after.
const SAT_TILE_BYTES: usize = 14_000; // ESRI World Imagery JPEG
const STRAVA_TILE_BYTES: usize = 5_000; // Strava heat PNG
const HILL_TILE_BYTES: usize = 12_000; // terrarium DEM tile

/// Per-tile byte estimate for Protomaps vector tiles, by zoom. One flat rate
/// can't span the range: measured against the planet build, a z7 region tile
/// runs ~40 KB and a z8–10 tile over a city ~50 KB. The old flat 800 B/tile
/// under-reported an NSW overview by 16x (1.3 MB in the dialog, 21 MB on
/// disk).
///
/// Deep zooms stay a compromise, because how built-up the ground is swings
/// them ~6x: the same z11–15 corridor cut measured 4.6 KB/tile through the
/// bush around Galston and 27 KB/tile across inner Sydney. These sit near the
/// geometric mean, so a rural corridor over-estimates and an urban one
/// under-estimates by roughly 2.5x either way. `pmtiles extract --dry-run`
/// would report the exact archive size, but it costs a ~3.5 s round trip per
/// tier — too slow for an endpoint the dialog hits on every toggle.
fn basemap_tile_bytes(z: u32) -> usize {
    match z {
        0..=7 => 40_000,
        8..=10 => 50_000,
        11 => 30_000,
        12 => 20_000,
        13 => 14_000,
        14 => 10_000,
        _ => 8_000,
    }
}

/// Summed size estimate for a set of basemap tiles.
fn basemap_bytes(tiles: &[(u32, u32, u32)]) -> usize {
    tiles.iter().map(|&(z, _, _)| basemap_tile_bytes(z)).sum()
}

/// The layer selection + knobs for a DingoNav bundle build — shared by the
/// `.dingonav` download and the pack publish path.
pub(crate) struct DingoNavOpts {
    pub(crate) include_tracks: bool,
    pub(crate) include_heatmap: bool,
    pub(crate) include_strava: bool,
    pub(crate) include_basemap: bool,
    pub(crate) include_satellite: bool,
    pub(crate) include_hillshade: bool,
    pub(crate) satellite_zoom: Option<u32>,
    pub(crate) heatmap_filters: Option<HeatmapFilters>,
    /// Per-layer corridor-vs-rect shape; default = all corridor.
    pub(crate) coverage: LayerCoverage,
    pub(crate) privacy: bool,
    /// Free-text pack notes, surfaced by DingoNav on load.
    pub(crate) description: String,
    /// Publish counter embedded in bundle.json — DingoNav shows it as the
    /// pack's vN badge and in the refresh toast. 0 = plain download with no
    /// publish behind it (DingoNav hides the badge for 0).
    pub(crate) revision: i32,
    /// Frozen group-ride channel name (pack publishes only) — DingoNav
    /// prefers it over the filename-derived default ride code, so renamed
    /// files still converge on one ntfy topic.
    pub(crate) ride_name: Option<String>,
    /// Accepted mark edits, replayed by DingoNav on bundle load (wire name
    /// `turnEdits` — the array pre-marks clients already understand).
    pub(crate) marks: Vec<super::marks::MarkEdit>,
}

/// Result of a DingoNav bundle build: the zip bytes plus the manifest the UI
/// reports (per-layer counts + real bytes).
pub(crate) struct DingoNavBuild {
    pub(crate) zip: Vec<u8>,
    pub(crate) manifest: serde_json::Value,
}

/// Build a one-file DingoNav bundle, a `.dingonav` **zip**:
///   bundle.json               tracks (GPX) + surrounding heatmap GeoJSON (v2)
///   basemap.pmtiles           corridor topo/vector extract (if include_basemap)
///   hillshade.pmtiles         corridor terrain DEM extract (if include_hillshade)
///   strava/{z}/{x}/{y}.png    corridor Strava heat tiles   (if include_strava)
///   satellite/{z}/{x}/{y}.jpg corridor + overview ESRI imagery (if include_satellite)
/// so a whole ride — map, imagery, tracks, heatmaps — travels as a single file.
/// The bundle.json keeps the exact tracks/heatmap shape DingoNav already parses.
pub(crate) async fn build_dingonav(
    pool: &PgPool,
    ride_ids: &[Uuid],
    bundle_name: &str,
    opts: &DingoNavOpts,
) -> Result<DingoNavBuild, ApiError> {
    // Tracks (basket order; skip superseded/geometry-less, report them).
    let mut tracks = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    if opts.include_tracks {
        (tracks, skipped) = dingonav_tracks(pool, ride_ids, opts.privacy).await?;
        if tracks.is_empty() {
            return Err(bad_request("none of the selected rides have usable geometry"));
        }
    }

    // Coverage shapes: the rect bbox always (rect layers + outside_coverage),
    // the track-following corridor polygon when any enabled layer wants it. A
    // failed/empty corridor (degenerate geometry) falls back to rect so a
    // publish never dies on geometry oddities.
    let bbox = selection_bbox(pool, ride_ids, opts.privacy).await?;
    let corridor = if opts.coverage.wants_corridor(opts) {
        selection_corridor(pool, ride_ids, opts.privacy).await?
    } else {
        None
    };
    // (bbox, polygon filter, extra bbox margin) for a layer's coverage mode.
    // The corridor polygon is pre-buffered, so its bbox takes no extra margin.
    let scope = |mode: Coverage| match (&corridor, mode) {
        (Some(c), Coverage::Corridor) => (Some(c.bbox), Some(&c.poly), 0.0),
        _ => (bbox, None, CORRIDOR_BUFFER_DEG),
    };
    let region = |mode: Coverage| match (&corridor, mode) {
        (Some(c), Coverage::Corridor) => Some(&c.geojson),
        _ => None,
    };

    // Overview region for the zoomed-out layers (basemap z0–10, Strava z8–10,
    // simplified region-wide own-heat): the top-level containing area, or the
    // configured fallback. None = those layers stay coverage-only.
    let overview = match bbox {
        Some(b) if opts.include_basemap || opts.include_strava || opts.include_heatmap => {
            overview_region(pool, b).await?
        }
        _ => None,
    };

    // Surrounding heatmap: rides intersecting the coverage shape, narrowed by
    // the filter-panel state when the request carries one. Same class rules as
    // GET /api/heatmap; the filter predicates mirror the client-side
    // visibility filters in MapView so the bundle matches the screen. Dates
    // compare as UTC YYYY-MM-DD strings, exactly like the UI. In corridor mode
    // the geometries are CLIPPED to the corridor polygon — a long neighbouring
    // ride that nicks the corridor contributes only the overlapping stretch.
    // With an overview region, simplified region-wide lines follow the detail.
    let mut features: Vec<serde_json::Value> = Vec::new();
    let mut overview_heat_count = 0usize;
    if opts.include_heatmap {
        features = dingonav_heat_features(
            pool,
            ride_ids,
            opts.heatmap_filters.as_ref(),
            region(opts.coverage.heatmap),
            opts.privacy,
        )
        .await?;
        // Zoomed-out lines: a buffer around the corridor (local) or the whole
        // containing region. Local doesn't need the region to resolve at all,
        // so a selection outside every known area still gets context.
        let (heat_shape, heat_buffer_m) = match opts.coverage.heat_overview {
            HeatOverview::None => (None, 0.0),
            HeatOverview::Local => match (&corridor, bbox) {
                (Some(c), _) => (Some(c.geojson.clone()), OVERVIEW_HEAT_RADIUS_M),
                (None, Some(b)) => (Some(bbox_polygon(b)), OVERVIEW_HEAT_RADIUS_M),
                (None, None) => (None, 0.0),
            },
            HeatOverview::Region => (overview.as_ref().map(|ov| ov.geojson.clone()), 0.0),
        };
        if let Some(shape) = heat_shape {
            let ov_features = overview_heat_features(
                pool,
                &shape,
                heat_buffer_m,
                opts.heatmap_filters.as_ref(),
                opts.privacy,
            )
            .await?;
            overview_heat_count = ov_features.len();
            features.extend(ov_features);
        }
    }

    // Basemap + hillshade: coverage-shaped PMTiles extracts (best-effort).
    let scratch = std::env::temp_dir().join(format!("dingo-dingonav-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).map_err(internal)?;
    let (basemap_path, basemap_note) = if opts.include_basemap {
        let (b, _, _) = scope(opts.coverage.basemap);
        extract_basemap(&scratch, b, region(opts.coverage.basemap), overview.as_ref())
    } else {
        (None, None)
    };
    let (hillshade_path, hillshade_note) = if opts.include_hillshade {
        let (b, _, _) = scope(opts.coverage.hillshade);
        extract_hillshade(&scratch, b, region(opts.coverage.hillshade))
    } else {
        (None, None)
    };

    // Strava + satellite tiles: coverage-shaped tile sets fetched live, capped.
    let (strava_ride, strava_hike, strava_note) = if opts.include_strava {
        let (b, p, m) = scope(opts.coverage.strava);
        fetch_corridor_strava(b, p, m, overview.as_ref()).await
    } else {
        (Vec::new(), Vec::new(), None)
    };
    let (satellite_tiles, satellite_note) = if opts.include_satellite {
        let (b, p, m) = scope(opts.coverage.satellite);
        fetch_corridor_satellite(b, p, m, opts.satellite_zoom.unwrap_or(SAT_ZMAX)).await
    } else {
        (Vec::new(), None)
    };

    // A ticked layer that produced nothing is a hard error, not a footnote.
    // Shipping it silently is how a pack reaches the trail with no map on it —
    // the rider only finds out where there's no signal to fix it.
    let empty_layer = |on: bool, empty: bool, layer: &str, note: &Option<String>| {
        (on && empty).then(|| {
            format!(
                "{layer} was requested but produced nothing: {}",
                note.clone().unwrap_or_else(|| "no tiles".into())
            )
        })
    };
    if let Some(msg) = empty_layer(opts.include_basemap, basemap_path.is_none(), "topo basemap", &basemap_note)
        .or_else(|| empty_layer(opts.include_hillshade, hillshade_path.is_none(), "hillshade", &hillshade_note))
        .or_else(|| {
            empty_layer(
                opts.include_strava,
                strava_ride.is_empty() && strava_hike.is_empty(),
                "Strava heatmap",
                &strava_note.as_ref().map(|n| n.to_string()),
            )
        })
        .or_else(|| {
            empty_layer(
                opts.include_satellite,
                satellite_tiles.is_empty(),
                "satellite imagery",
                &satellite_note.as_ref().map(|n| n.to_string()),
            )
        })
    {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err(bad_request(format!("{msg} — untick the layer or fix the source, then retry")));
    }

    // Per-section sizes for the manifest (raw bytes as they enter the zip:
    // GPX/heatmap deflate further inside bundle.json, tiles are stored as-is).
    let tracks_bytes: usize = tracks.iter().map(|t| t.gpx.len()).sum();
    let heatmap = if opts.include_heatmap {
        serde_json::json!({ "type": "FeatureCollection", "features": features })
    } else {
        serde_json::Value::Null
    };
    let heatmap_bytes = if opts.include_heatmap {
        serde_json::to_vec(&heatmap).map_err(internal)?.len()
    } else {
        0
    };
    let strava_bytes: usize = strava_ride.iter().chain(strava_hike.iter()).map(|(_, _, _, b)| b.len()).sum();
    let satellite_bytes: usize = satellite_tiles.iter().map(|(_, _, _, b)| b.len()).sum();
    let file_bytes = |p: &Option<PathBuf>| {
        p.as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map_or(0, |m| m.len() as usize)
    };
    let basemap_bytes = file_bytes(&basemap_path);
    let hillshade_bytes = file_bytes(&hillshade_path);

    // bundle.json — same tracks/heatmap shape DingoNav parses today, + v2 meta.
    // Emits BOTH name and bundleId/bundleName so the pack-publish and plain
    // download paths share one shape (DingoNav reads `bundleName || name`;
    // bundleId keys the pack on the phone — same name ⇒ same pack, so a
    // re-exported zip replaces rather than duplicates).
    // Version 3 documents the overview semantics (heat features tagged
    // `overview: true`, Strava z8–10 region tiles, merged z0–10 basemap);
    // DingoNav doesn't gate on the value, so v2 consumers load this fine.
    let bundle_json = serde_json::json!({
        "version": 3,
        "name": bundle_name,
        "bundleId": slugify(bundle_name),
        "bundleName": bundle_name,
        "description": opts.description,
        "revision": opts.revision,
        "heatmapName": format!("heatmap-{bundle_name}.geojson"),
        "heatmap": heatmap,
        "tracks": tracks,
        "skipped": skipped,
        "basemap": basemap_path.as_ref().map(|_| "basemap.pmtiles"),
        "hillshade": hillshade_path.as_ref().map(|_| "hillshade.pmtiles"),
        "strava": strava_note.clone(),
        "satellite": satellite_note.clone(),
        "coverage": opts.coverage,
        "overview": overview.as_ref().map(|ov| ov.name.clone()),
        "rideName": opts.ride_name,
        "turnEdits": opts.marks,
    });

    let zip_result = build_dingonav_zip(
        &serde_json::to_vec(&bundle_json).map_err(internal)?,
        basemap_path.as_deref(),
        hillshade_path.as_deref(),
        &strava_ride,
        &strava_hike,
        &satellite_tiles,
    );
    let _ = std::fs::remove_dir_all(&scratch);
    let zip = zip_result.map_err(internal)?;

    let manifest = serde_json::json!({
        "tracks": tracks.len(),
        "tracks_bytes": tracks_bytes,
        "heatmap_features": features.len(),
        "heatmap_overview_features": overview_heat_count,
        "heatmap_bytes": heatmap_bytes,
        "overview": overview.as_ref().map(|ov| ov.name.clone()),
        "skipped": skipped.len(),
        "strava": strava_note,
        "strava_bytes": strava_bytes,
        "satellite": satellite_note,
        "satellite_bytes": satellite_bytes,
        "basemap": basemap_path.as_ref().map(|_| serde_json::json!({ "included": true }))
            .unwrap_or_else(|| serde_json::json!({ "included": false, "note": basemap_note })),
        "basemap_bytes": basemap_bytes,
        "hillshade": hillshade_path.as_ref().map(|_| serde_json::json!({ "included": true }))
            .unwrap_or_else(|| serde_json::json!({ "included": false, "note": hillshade_note })),
        "hillshade_bytes": hillshade_bytes,
        "bytes": zip.len(),
    });

    Ok(DingoNavBuild { zip, manifest })
}

/// Plain `.dingonav` download — same builder as pack publish ([`build_dingonav`]),
/// streamed back as a zip. Revision 0 marks a download with no share behind it.
async fn export_dingonav(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<DingoNavRequest>,
) -> Result<Response, ApiError> {
    if body.ride_ids.is_empty() {
        return Err(bad_request("ride_ids must not be empty"));
    }
    let bundle_name = sanitize(body.name.trim());
    if bundle_name == "Unknown" && body.name.trim().is_empty() {
        return Err(bad_request("bundle name must not be empty"));
    }

    let opts = DingoNavOpts {
        include_tracks: body.include_tracks,
        include_heatmap: body.include_heatmap,
        include_strava: body.include_strava,
        include_basemap: body.include_basemap,
        include_satellite: body.include_satellite,
        include_hillshade: body.include_hillshade,
        satellite_zoom: body.satellite_zoom,
        heatmap_filters: body.heatmap_filters.clone(),
        coverage: body.coverage,
        privacy: body.privacy,
        description: String::new(),
        revision: 0,
        ride_name: None,
        marks: Vec::new(),
    };
    let build = build_dingonav(&pool, &body.ride_ids, &bundle_name, &opts).await?;

    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}.dingonav\"", bundle_name.replace('"', "")),
        )
        .header("x-dingo-manifest", percent_encode_json(&build.manifest))
        .body(Body::from(build.zip))
        .map_err(internal)?)
}

// ---- Pre-build size estimate ----

/// Estimate enumeration caps for the un-capped extract layers — purely a bound
/// on the tile-counting loop for a country-spanning selection, not a build cap.
const BASEMAP_EST_CAP: usize = 50_000;
const HILL_EST_CAP: usize = 20_000;

#[derive(Debug, Deserialize)]
struct EstimateRequest {
    ride_ids: Vec<Uuid>,
    #[serde(default)]
    satellite_zoom: Option<u32>,
    #[serde(default)]
    coverage: LayerCoverage,
}

/// Pure tile-math per-layer size estimate for a selection — no fetching, no
/// pmtiles runs — so the export dialog / pack detail can size layers live.
/// Estimates deliberately ignore privacy zones: trimming barely moves the
/// tile counts (the zone is a pinprick in a corridor) and skipping it keeps
/// the expensive geometry difference out of this hot, on-keystroke path. The
/// real export still applies privacy. Tile counting runs against a further
/// VW-simplified copy of the corridor — boundary-tile membership can drift a
/// few percent, which the ~ labels already promise.
/// Also returns the coverage shapes (corridor polygon + rect bbox) so the map
/// can preview what a bundle will cover.
async fn estimate_export(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<EstimateRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (bbox, corridor) = if body.ride_ids.is_empty() {
        (None, None)
    } else {
        (
            selection_bbox(&pool, &body.ride_ids, false).await?,
            selection_corridor(&pool, &body.ride_ids, false).await?,
        )
    };
    // Counting-only copy of the corridor, simplified hard (VW keeps the ring
    // topology valid). The corridor is ~1.5 km wide, so a few-hundred-metre
    // boundary shift only flips edge tiles — and it makes each per-tile
    // intersection test ~10x cheaper on long multi-day routes.
    use geo::SimplifyVwPreserve as _;
    let test_poly = corridor
        .as_ref()
        .map(|c| c.poly.simplify_vw_preserve(&1e-5));
    let scope = |mode: Coverage| match (&corridor, &test_poly, mode) {
        (Some(c), Some(p), Coverage::Corridor) => Some((c.bbox, Some(p), 0.0)),
        _ => bbox.map(|b| (b, None, CORRIDOR_BUFFER_DEG)),
    };
    let layer = |mode: Coverage, zmin: u32, zmax: u32, cap: usize, per_tile: usize| match scope(mode)
    {
        Some((b, p, m)) => {
            let (tiles, _, capped) = corridor_tiles(b, p, m, zmin, zmax, cap);
            serde_json::json!({
                "tiles": tiles.len(),
                "bytes": tiles.len() * per_tile,
                "capped": capped,
            })
        }
        None => serde_json::json!({ "tiles": 0, "bytes": 0, "capped": false }),
    };
    let sat_zmax = body.satellite_zoom.unwrap_or(SAT_ZMAX).clamp(SAT_ZMIN, SAT_ZMAX);
    // Satellite ships a z0–11 rect pyramid on top of the corridor tiles (see
    // fetch_corridor_satellite); count it so the dialog's size matches.
    let satellite_est = match scope(body.coverage.satellite) {
        Some((b, p, m)) => {
            let (tiles, _, capped) = corridor_tiles(b, p, m, SAT_ZMIN, sat_zmax, SAT_TILE_CAP);
            let (ov, _, ov_capped) = corridor_tiles(b, None, m, 0, OVERVIEW_SAT_ZMAX, OVERVIEW_SAT_CAP);
            let n = tiles.len() + ov.len();
            serde_json::json!({ "tiles": n, "bytes": n * SAT_TILE_BYTES, "capped": capped || ov_capped })
        }
        None => serde_json::json!({ "tiles": 0, "bytes": 0, "capped": false }),
    };
    let rect = bbox.map(|b| {
        [
            b[0] - CORRIDOR_BUFFER_DEG,
            b[1] - CORRIDOR_BUFFER_DEG,
            b[2] + CORRIDOR_BUFFER_DEG,
            b[3] + CORRIDOR_BUFFER_DEG,
        ]
    });
    // Overview: what the zoomed-out layers would add, plus the region outline
    // for the map preview.
    let overview = match bbox {
        Some(b) => overview_region(&pool, b).await?,
        None => None,
    };
    let overview_json = overview.as_ref().map(|ov| {
        // Mirrors extract_basemap's tiering: region z0–7 + local rect z8–10.
        let (bm, _, _) =
            corridor_tiles(ov.bbox, Some(&ov.poly), 0.0, 0, OVERVIEW_BASEMAP_MAXZOOM, BASEMAP_EST_CAP);
        let local = bbox
            .map(|b| {
                corridor_tiles(
                    b,
                    None,
                    LOCAL_BASEMAP_MARGIN_DEG,
                    LOCAL_BASEMAP_ZMIN,
                    LOCAL_BASEMAP_ZMAX,
                    BASEMAP_EST_CAP,
                )
                .0
            })
            .unwrap_or_default();
        let (sv, _, _) = corridor_tiles(
            ov.bbox,
            Some(&ov.poly),
            0.0,
            OVERVIEW_STRAVA_ZMIN,
            OVERVIEW_STRAVA_ZMAX,
            OVERVIEW_STRAVA_CAP,
        );
        serde_json::json!({
            "area": ov.name,
            "basemap": {
                "tiles": bm.len() + local.len(),
                "bytes": basemap_bytes(&bm) + basemap_bytes(&local),
            },
            "strava": { "tiles": sv.len(), "bytes": sv.len() * STRAVA_TILE_BYTES },
            "region": ov.geojson,
        })
    });
    // Basemap detail band. With an overview region the low/mid zooms are cut
    // separately (counted under "overview"), so the layer itself only carries
    // z11–15; without one, extract_basemap falls back to a single coverage-
    // shaped z0–15 extract and the estimate has to match.
    let basemap_zmin = if overview.is_some() { LOCAL_BASEMAP_ZMAX + 1 } else { 0 };
    let basemap_est = match scope(body.coverage.basemap) {
        Some((b, p, m)) => {
            let (tiles, _, capped) = corridor_tiles(b, p, m, basemap_zmin, 15, BASEMAP_EST_CAP);
            serde_json::json!({
                "tiles": tiles.len(),
                "bytes": basemap_bytes(&tiles),
                "capped": capped,
            })
        }
        None => serde_json::json!({ "tiles": 0, "bytes": 0, "capped": false }),
    };
    // The default heat scope ("local") reaches 50 km past the corridor; hand
    // that shape back so the pack preview can mask the heat honestly.
    let heat_local = match corridor.as_ref() {
        Some(c) => heat_local_shape(&pool, &c.geojson).await?,
        None => None,
    };
    Ok(Json(serde_json::json!({
        "satellite": satellite_est,
        "strava": layer(body.coverage.strava, STRAVA_ZMIN, STRAVA_ZMAX, STRAVA_TILE_CAP, STRAVA_TILE_BYTES),
        "basemap": basemap_est,
        "hillshade": layer(body.coverage.hillshade, 0, 12, HILL_EST_CAP, HILL_TILE_BYTES),
        "has_geometry": bbox.is_some(),
        "corridor": corridor.as_ref().map(|c| c.geojson.clone()),
        "heat_local": heat_local,
        "rect": rect,
        "overview": overview_json,
        // Preflight: dead/uncovering sources, surfaced before the build.
        "sources": {
            "basemap": source_status("DINGO_BASEMAP_PMTILES", bbox),
            "hillshade": source_status("DINGO_HILLSHADE_PMTILES", bbox),
        },
    })))
}

// ---- Raster heatmap tiles (.mbtiles overlay) ----

fn default_heat_min_zoom() -> u32 {
    5
}
fn default_heat_max_zoom() -> u32 {
    14
}
fn default_hot_at() -> f64 {
    15.0
}

#[derive(Debug, Deserialize)]
struct HeatTilesRequest {
    ride_ids: Vec<Uuid>,
    name: String,
    #[serde(default = "default_heat_min_zoom")]
    min_zoom: u32,
    #[serde(default = "default_heat_max_zoom")]
    max_zoom: u32,
    /// Distinct-ride count that saturates to white-hot.
    #[serde(default = "default_hot_at")]
    hot_at: f64,
    /// Remove privacy-zone geometry (default on).
    #[serde(default = "default_true")]
    privacy: bool,
}

/// Render the selected rides into a raster density-heatmap MBTiles and stream
/// it back as a `.mbtiles` download (Strava-style glow — distinct rides per
/// pixel — for offline OsmAnd/Locus overlays). Built to a scratch file, read,
/// streamed, deleted; a failure mid-build returns an error, never a partial
/// archive.
async fn export_heatmap_tiles(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<HeatTilesRequest>,
) -> Result<Response, ApiError> {
    if body.ride_ids.is_empty() {
        return Err(bad_request("ride_ids must not be empty"));
    }
    let bundle_name = sanitize(body.name.trim());
    if bundle_name == "Unknown" && body.name.trim().is_empty() {
        return Err(bad_request("bundle name must not be empty"));
    }
    // Clamp zooms so a web-triggered render stays bounded (the renderer caps at
    // 16 too; each extra level roughly quadruples tiles).
    let min_zoom = body.min_zoom.clamp(1, 16);
    let max_zoom = body.max_zoom.clamp(min_zoom, 16);

    let opts = HeatTilesOptions {
        scope: HeatScope::Rides(body.ride_ids.clone()),
        min_zoom,
        max_zoom,
        mode_filter: None,
        hot_at: body.hot_at,
        privacy: body.privacy,
    };

    let scratch = std::env::temp_dir().join(format!("dingo-heattiles-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).map_err(internal)?;
    let out = scratch.join(format!("{bundle_name}.mbtiles"));
    let build = build_heat_mbtiles(&pool, &out, &opts, |_, _, _| {})
        .await
        .map_err(|e| bad_request(e.to_string()));
    let read = build.and_then(|summary| std::fs::read(&out).map(|b| (summary, b)).map_err(internal));
    let _ = std::fs::remove_dir_all(&scratch);
    let (summary, bytes) = read?;

    let manifest = serde_json::json!({
        "rides": summary.rides,
        "tiles": summary.tiles,
        "bytes": bytes.len(),
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
    });

    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}.mbtiles\"", bundle_name.replace('"', "")),
        )
        .header("x-dingo-manifest", percent_encode_json(&manifest))
        .body(Body::from(bytes))
        .map_err(internal)?)
}

// ---- Share-by-link (secret GitHub gist) ----

#[derive(Debug, Deserialize)]
struct ShareRequest {
    ride_ids: Vec<Uuid>,
    name: String,
    #[serde(default = "default_true")]
    include_tracks: bool,
    #[serde(default = "default_true")]
    include_heatmap: bool,
    #[serde(default)]
    heatmap_filters: Option<HeatmapFilters>,
    #[serde(default = "default_true")]
    privacy: bool,
}

/// Publish a privacy-trimmed DingoNav bundle as a SECRET GitHub gist via the
/// local logged-in `gh` CLI and return a one-tap DingoNav link
/// (`<nav>/?bundle=<gist raw url>`). Gists are text-only, so the share is the
/// plain bundle.json (tracks + surrounding heatmap — no basemap/Strava tiles;
/// DingoNav fetches those layers itself when online). Secret gists are
/// unlisted but readable by anyone holding the link; they can be deleted at
/// gist.github.com any time.
///
/// Shares are LIVING LINKS: one gist per share name (slug). Re-sharing a name
/// PATCHes the existing gist in place and bumps the revision — the raw URL a
/// mate already has redirects to the latest revision, so their pack refreshes
/// without a new link.
async fn export_share(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<ShareRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.ride_ids.is_empty() {
        return Err(bad_request("ride_ids must not be empty"));
    }
    let bundle_name = sanitize(body.name.trim());
    if bundle_name == "Unknown" && body.name.trim().is_empty() {
        return Err(bad_request("bundle name must not be empty"));
    }
    let slug = slugify(&bundle_name);

    // Existing share with this slug? Then this is an update, not a create.
    let existing = sqlx::query(
        "SELECT id, gist_id, gist_user, revision FROM shares WHERE slug = $1",
    )
    .bind(&slug)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;
    let revision = existing
        .as_ref()
        .map_or(1, |r| r.get::<i32, _>("revision") + 1);

    let (tracks, skipped) = if body.include_tracks {
        let (t, s) = dingonav_tracks(&pool, &body.ride_ids, body.privacy).await?;
        if t.is_empty() && !body.include_heatmap {
            return Err(bad_request("none of the selected rides have usable geometry"));
        }
        (t, s)
    } else {
        (Vec::new(), Vec::new())
    };
    let features = if body.include_heatmap {
        // Corridor-clipped like the pack path; a degenerate corridor falls
        // back to the legacy rect envelope.
        let corridor = selection_corridor(&pool, &body.ride_ids, body.privacy).await?;
        dingonav_heat_features(
            &pool,
            &body.ride_ids,
            body.heatmap_filters.as_ref(),
            corridor.as_ref().map(|c| &c.geojson),
            body.privacy,
        )
        .await?
    } else {
        Vec::new()
    };

    let bundle_json = serde_json::json!({
        "version": 2,
        "bundleId": slug,
        "bundleName": bundle_name,
        "revision": revision,
        "heatmapName": format!("heatmap-{bundle_name}.geojson"),
        "heatmap": if body.include_heatmap {
            serde_json::json!({ "type": "FeatureCollection", "features": features })
        } else { serde_json::Value::Null },
        "tracks": tracks,
        "skipped": skipped,
    });
    let bytes = serde_json::to_vec(&bundle_json).map_err(internal)?;

    // The gist filename derives from the SLUG (not the raw name) so an update
    // always replaces the same file — a differently-punctuated name would
    // otherwise ADD a second file to the gist instead of updating it.
    let file_name = format!("{slug}.dingonav.json");
    let scratch = std::env::temp_dir().join(format!("dingo-share-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).map_err(internal)?;

    let (gist_id, gist_user, updated) = if let Some(row) = &existing {
        let gist_id: String = row.get("gist_id");
        let gist_user: String = row.get("gist_user");
        // PATCH the gist file content via `gh api --input` — non-interactive,
        // exact filename targeting (gh gist edit wants an $EDITOR).
        let patch = serde_json::json!({
            "description": format!("DingoNav bundle — {bundle_name} (v{revision})"),
            "files": { &file_name: { "content": String::from_utf8_lossy(&bytes) } },
        });
        let patch_path = scratch.join("patch.json");
        let write = std::fs::write(&patch_path, serde_json::to_vec(&patch).map_err(internal)?);
        let out = match write {
            Ok(()) => {
                tokio::process::Command::new("gh")
                    .args(["api", "-X", "PATCH", "--input"])
                    .arg(&patch_path)
                    .arg(format!("gists/{gist_id}"))
                    .output()
                    .await
            }
            Err(e) => Err(e),
        };
        let _ = std::fs::remove_dir_all(&scratch);
        let out = out.map_err(|e| {
            (
                StatusCode::NOT_IMPLEMENTED,
                format!("GitHub CLI (gh) not runnable: {e} — install gh and run `gh auth login`"),
            )
        })?;
        if !out.status.success() {
            return Err(internal(format!(
                "gh api gists/{gist_id} PATCH failed: {} — the gist may have been deleted; rename the share or remove its row",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        sqlx::query(
            "UPDATE shares SET name = $2, ride_ids = $3, revision = $4, updated_at = now() WHERE slug = $1",
        )
        .bind(&slug)
        .bind(&bundle_name)
        .bind(&body.ride_ids)
        .bind(revision)
        .execute(&pool)
        .await
        .map_err(internal)?;
        (gist_id, gist_user, true)
    } else {
        // First share of this name: create the gist (default visibility is
        // secret) and remember it so the next share of this name updates it.
        let file_path = scratch.join(&file_name);
        let write = std::fs::write(&file_path, &bytes);
        let out = match write {
            Ok(()) => {
                tokio::process::Command::new("gh")
                    .args(["gist", "create", "--desc"])
                    .arg(format!("DingoNav bundle — {bundle_name} (v1)"))
                    .arg(&file_path)
                    .output()
                    .await
            }
            Err(e) => Err(e),
        };
        let _ = std::fs::remove_dir_all(&scratch);
        let out = out.map_err(|e| {
            (
                StatusCode::NOT_IMPLEMENTED,
                format!("GitHub CLI (gh) not runnable: {e} — install gh and run `gh auth login`"),
            )
        })?;
        if !out.status.success() {
            return Err(internal(format!(
                "gh gist create failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        let gist_url = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // https://gist.github.com/<user>/<id>
        let mut parts = gist_url.rsplitn(3, '/');
        let (Some(id), Some(user)) = (parts.next(), parts.next()) else {
            return Err(internal(format!("unexpected gh output: {gist_url}")));
        };
        let (id, user) = (id.to_string(), user.to_string());
        sqlx::query(
            "INSERT INTO shares (name, slug, gist_id, gist_user, ride_ids) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&bundle_name)
        .bind(&slug)
        .bind(&id)
        .bind(&user)
        .bind(&body.ride_ids)
        .execute(&pool)
        .await
        .map_err(internal)?;
        (id, user, false)
    };

    let gist_url = format!("https://gist.github.com/{gist_user}/{gist_id}");
    // Raw single-file URL WITHOUT a revision sha — redirects to the latest
    // revision, which is what makes the link a living one. Served with CORS
    // so DingoNav can fetch it.
    let raw_url = format!("https://gist.githubusercontent.com/{gist_user}/{gist_id}/raw");
    let share_url = format!(
        "{}?bundle={}",
        nav_base_url(),
        percent_encode_component(&raw_url)
    );

    Ok(Json(serde_json::json!({
        "share_url": share_url,
        "gist_url": gist_url,
        "slug": slug,
        "revision": revision,
        "updated": updated,
        "tracks": tracks.len(),
        "heatmap_features": features.len(),
        "skipped": skipped,
        "bytes": bytes.len(),
    })))
}

/// List remembered shares so the UI can show which names are living links.
async fn list_shares(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, slug, gist_id, gist_user, revision, \
         cardinality(ride_ids) AS ride_count, updated_at::text AS updated_at \
         FROM shares ORDER BY updated_at DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    let nav_base = nav_base_url();
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                let gist_user: String = r.get("gist_user");
                let gist_id: String = r.get("gist_id");
                let raw_url =
                    format!("https://gist.githubusercontent.com/{gist_user}/{gist_id}/raw");
                serde_json::json!({
                    "id": r.get::<Uuid, _>("id"),
                    "name": r.get::<String, _>("name"),
                    "slug": r.get::<String, _>("slug"),
                    "revision": r.get::<i32, _>("revision"),
                    "ride_count": r.get::<i32, _>("ride_count"),
                    "updated_at": r.get::<String, _>("updated_at"),
                    "gist_url": format!("https://gist.github.com/{gist_user}/{gist_id}"),
                    "share_url": format!("{nav_base}?bundle={}", percent_encode_component(&raw_url)),
                })
            })
            .collect(),
    ))
}

fn nav_base_url() -> String {
    std::env::var("DINGO_NAV_URL")
        .unwrap_or_else(|_| "https://grantpaisley.github.io/DingoNav/".to_string())
}

pub fn nav_base() -> String {
    nav_base_url()
}

/// The shares repo from the env, or 501 with a setup hint.
pub fn share_repo() -> Result<String, ApiError> {
    std::env::var("DINGO_SHARE_REPO").map_err(|_| {
        (
            StatusCode::NOT_IMPLEMENTED,
            "DINGO_SHARE_REPO not set — create a public repo (e.g. grantpaisley/dingo-shares) \
             and set DINGO_SHARE_REPO to it"
                .to_string(),
        )
    })
}

/// Run `gh api -X <method> <path>` (body, when given, is JSON on stdin) and
/// parse the JSON response. Err carries gh's stderr (e.g. "Not Found (404)").
pub async fn gh_api(
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(["api", "-X", method, path]);
    if body.is_some() {
        cmd.args(["--input", "-"]);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("GitHub CLI (gh) not runnable: {e} — install gh and run `gh auth login`"))?;
    if let Some(b) = body {
        use tokio::io::AsyncWriteExt;
        let bytes = serde_json::to_vec(b).map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(&bytes).await.map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("unparseable gh api response: {e}"))
}

/// Map a gh_api error string onto an API error, keeping "gh missing" distinct.
pub fn map_gh_err(e: String, repo: &str) -> ApiError {
    if e.contains("not runnable") {
        (StatusCode::NOT_IMPLEMENTED, e)
    } else {
        internal(format!("GitHub API call failed (repo {repo}): {e}"))
    }
}

/// Pack key shared with DingoNav: lowercase alphanumeric runs joined by
/// dashes ("Singleton overnight!" → "singleton-overnight"). Same name ⇒ same
/// slug ⇒ same pack on the phone — that collision is the desired semantics.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "share".to_string() } else { out }
}

/// Percent-encode a URL for embedding as a query-parameter value.
pub(crate) fn percent_encode_component(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Per-ride GPX for a DingoNav bundle (basket order; skips superseded /
/// geometry-less / fully-private rides and reports them by name).
async fn dingonav_tracks(
    pool: &PgPool,
    ride_ids: &[Uuid],
    privacy: bool,
) -> Result<(Vec<DingoNavTrack>, Vec<String>), ApiError> {
    let mut tracks = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let rows =
        sqlx::query("SELECT id, name FROM rides WHERE id = ANY($1) AND superseded_by IS NULL")
            .bind(ride_ids)
            .fetch_all(pool)
            .await
            .map_err(internal)?;
    // name is nullable — a web-imported ride whose naming failed has NULL;
    // reading it as String would panic and drop the request (audit M4).
    let names: std::collections::HashMap<Uuid, String> = rows
        .into_iter()
        .map(|r| {
            let name = r
                .get::<Option<String>, _>("name")
                .unwrap_or_else(|| "Unnamed ride".to_string());
            (r.get::<Uuid, _>("id"), name)
        })
        .collect();
    let mut taken = std::collections::HashSet::new();
    for id in ride_ids {
        let Some(nm) = names.get(id) else {
            skipped.push(id.to_string());
            continue;
        };
        match build_ride_gpx(pool, *id, nm, None, privacy, None).await.map_err(internal)? {
            dingo_export::RideGpx::Gpx(gpx) => {
                let mut file = sanitize_filename(nm);
                let mut n = 2;
                while !taken.insert(file.clone()) {
                    file = format!("{} ({n})", sanitize_filename(nm));
                    n += 1;
                }
                tracks.push(DingoNavTrack { name: format!("{file}.gpx"), gpx, ride_id: *id });
            }
            dingo_export::RideGpx::NoGeometry | dingo_export::RideGpx::FullyPrivate => {
                skipped.push(nm.clone())
            }
        }
    }
    Ok((tracks, skipped))
}

/// Surrounding-heatmap GeoJSON features for a selection, privacy-trimmed,
/// narrowed by the filter-panel state when given. With a `corridor` polygon
/// (GeoJSON MultiPolygon) the rides are those intersecting the corridor and
/// their geometries are CLIPPED to it; without one it's the legacy rect
/// behaviour — whole geometries of rides touching the selection bbox + margin.
/// Shared by the .dingonav download, pack publish, and share-link paths.
async fn dingonav_heat_features(
    pool: &PgPool,
    ride_ids: &[Uuid],
    hf: Option<&HeatmapFilters>,
    corridor: Option<&serde_json::Value>,
    privacy: bool,
) -> Result<Vec<serde_json::Value>, ApiError> {
    // Two query shapes rather than one conditional mega-SQL: the corridor
    // variant clips (ST_Intersection) against a passed-in polygon; the rect
    // variant ships whole geometries inside the selection envelope. Both keep
    // the sargable ST_Intersects on cleaned_geometry for the GIST index and
    // share the $1–$8 binds.
    let corridor_sql = r#"
        WITH sel AS (
            SELECT ST_SetSRID(ST_GeomFromGeoJSON($9), 4326) AS env
        )
        SELECT
            CASE
                WHEN r.origin = 'other' THEN 'other'
                WHEN r.track_type = 'route' OR r.started_at IS NULL THEN 'plan'
                ELSE 'own'
            END AS class,
            r.mode::text AS mode,
            ST_AsGeoJSON(ST_SimplifyPreserveTopology(clip.g, 0.0001), 5)::json AS geometry
        FROM rides r, sel,
             LATERAL (
                 SELECT CASE WHEN $8 THEN ST_CollectionExtract(
                     ST_Difference(
                         r.cleaned_geometry,
                         COALESCE((SELECT ST_Union(boundary) FROM privacy_zones),
                                  ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326))),
                     2) ELSE r.cleaned_geometry END AS g
             ) priv,
             LATERAL (
                 SELECT ST_CollectionExtract(ST_Intersection(priv.g, sel.env), 2) AS g
             ) clip
        WHERE r.cleaned_geometry IS NOT NULL
          AND r.superseded_by IS NULL
          AND r.kind = 'recorded'
          AND ST_Intersects(r.cleaned_geometry, sel.env)
          AND NOT ST_IsEmpty(clip.g)
          AND ($2::text[] IS NULL OR (CASE
                WHEN r.origin = 'other' THEN 'other'
                WHEN r.track_type = 'route' OR r.started_at IS NULL THEN 'plan'
                ELSE 'own'
              END) = ANY($2))
          AND ($3::text[] IS NULL OR COALESCE(r.mode::text, 'other') = ANY($3))
          AND (NOT $4 OR r.avg_hr IS NOT NULL)
          AND (NOT $5 OR r.avg_speed_kmh IS NOT NULL)
          AND ($6::text IS NULL OR (r.started_at IS NOT NULL
                AND to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') >= $6))
          AND ($7::text IS NULL OR (r.started_at IS NOT NULL
                AND to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= $7))
        "#;
    let rect_sql = r#"
        WITH sel AS (
            SELECT ST_SetSRID(ST_Expand(ST_Extent(cleaned_geometry)::geometry, 0.02), 4326) AS env
            FROM rides WHERE id = ANY($1)
        )
        SELECT
            CASE
                WHEN r.origin = 'other' THEN 'other'
                WHEN r.track_type = 'route' OR r.started_at IS NULL THEN 'plan'
                ELSE 'own'
            END AS class,
            r.mode::text AS mode,
            ST_AsGeoJSON(ST_SimplifyPreserveTopology(priv.g, 0.0001), 5)::json AS geometry
        FROM rides r, sel,
             LATERAL (
                 -- Remove privacy-zone points when $8 (privacy) is on;
                 -- otherwise ship the full geometry.
                 SELECT CASE WHEN $8 THEN ST_CollectionExtract(
                     ST_Difference(
                         r.cleaned_geometry,
                         COALESCE((SELECT ST_Union(boundary) FROM privacy_zones),
                                  ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326))),
                     2) ELSE r.cleaned_geometry END AS g
             ) priv
        WHERE r.cleaned_geometry IS NOT NULL
          AND r.superseded_by IS NULL
          AND r.kind = 'recorded'
          AND NOT ST_IsEmpty(priv.g)
          AND ST_Intersects(r.cleaned_geometry, sel.env)
          AND ($2::text[] IS NULL OR (CASE
                WHEN r.origin = 'other' THEN 'other'
                WHEN r.track_type = 'route' OR r.started_at IS NULL THEN 'plan'
                ELSE 'own'
              END) = ANY($2))
          AND ($3::text[] IS NULL OR COALESCE(r.mode::text, 'other') = ANY($3))
          AND (NOT $4 OR r.avg_hr IS NOT NULL)
          AND (NOT $5 OR r.avg_speed_kmh IS NOT NULL)
          AND ($6::text IS NULL OR (r.started_at IS NOT NULL
                AND to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') >= $6))
          AND ($7::text IS NULL OR (r.started_at IS NOT NULL
                AND to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= $7))
        "#;
    let features: Vec<serde_json::Value>;
        let mut q = sqlx::query(if corridor.is_some() { corridor_sql } else { rect_sql })
        .bind(ride_ids)
        .bind(hf.map(|f| f.classes.clone()))
        .bind(hf.map(|f| f.modes.clone()))
        .bind(hf.is_some_and(|f| f.require_hr))
        .bind(hf.is_some_and(|f| f.require_speed))
        .bind(hf.and_then(|f| f.date_from.clone()))
        .bind(hf.and_then(|f| f.date_to.clone()))
        .bind(privacy);
        if let Some(c) = corridor {
            q = q.bind(serde_json::to_string(c).map_err(internal)?);
        }
        let heat_rows = q.fetch_all(pool)
        .await
        .map_err(internal)?;
        features = heat_rows
            .into_iter()
            .filter_map(|r| {
                let geometry: Option<serde_json::Value> = r.get("geometry");
                geometry.map(|g| {
                    serde_json::json!({
                        "type": "Feature",
                        "properties": {
                            "class": r.get::<String, _>("class"),
                            "mode": r.get::<String, _>("mode"),
                        },
                        "geometry": g,
                    })
                })
            })
            .collect();
    Ok(features)
}

/// Zoomed-out overview heat: heavily-simplified (~500 m) own/other/plan lines
/// across `region` — either a ~50 km buffer around the corridor or a whole
/// containing area, per [`HeatOverview`] — appended after the corridor-clipped
/// detail features. Tagged `overview: true` so DingoNav can thin/fade them at high
/// zooms; old builds render them as ordinary heat lines (the detail lines draw
/// on top). Most-recent-first, honouring the same filter-panel state, and
/// bounded by both a feature count and a byte budget.
///
/// Geometries are CLIPPED to the region, like the corridor query — an
/// interstate ride that only clips NSW's corner used to ship whole, so a
/// Sydney pack carried heat lines from SA to QLD (4 MB of bundle.json).
async fn overview_heat_features(
    pool: &PgPool,
    region: &serde_json::Value,
    buffer_m: f64,
    hf: Option<&HeatmapFilters>,
    privacy: bool,
) -> Result<Vec<serde_json::Value>, ApiError> {
    let rows = sqlx::query(
        r#"
        WITH sel AS (
            -- $13 = 0 uses the shape as given (a region boundary); a positive
            -- radius grows the corridor into the local catchment. The corridor
            -- is already simplified to ~100 m, and quad_segs 1 is plenty at
            -- 50 km — this shape only decides which rides come along.
            SELECT CASE WHEN $13 > 0 THEN
                ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)::geography, $13, 1)::geometry
            ELSE ST_SetSRID(ST_GeomFromGeoJSON($9), 4326) END AS env
        )
        , cand AS (
            SELECT
                CASE
                    WHEN r.origin = 'other' THEN 'other'
                    WHEN r.track_type = 'route' OR r.started_at IS NULL THEN 'plan'
                    ELSE 'own'
                END AS class,
                r.mode::text AS mode,
                r.started_at,
                ST_AsGeoJSON(ST_SimplifyPreserveTopology(clip.g, 0.005), 4) AS gj
            FROM rides r, sel,
                 LATERAL (
                     SELECT CASE WHEN $8 THEN ST_CollectionExtract(
                         ST_Difference(
                             r.cleaned_geometry,
                             COALESCE((SELECT ST_Union(boundary) FROM privacy_zones),
                                      ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326))),
                         2) ELSE r.cleaned_geometry END AS g
                 ) priv,
                 LATERAL (
                     SELECT ST_CollectionExtract(ST_Intersection(priv.g, sel.env), 2) AS g
                 ) clip
            WHERE r.cleaned_geometry IS NOT NULL
              AND r.superseded_by IS NULL
              AND r.kind = 'recorded'
              AND NOT ST_IsEmpty(clip.g)
              AND ST_Intersects(r.cleaned_geometry, sel.env)
              AND ($2::text[] IS NULL OR (CASE
                    WHEN r.origin = 'other' THEN 'other'
                    WHEN r.track_type = 'route' OR r.started_at IS NULL THEN 'plan'
                    ELSE 'own'
                  END) = ANY($2))
              AND ($3::text[] IS NULL OR COALESCE(r.mode::text, 'other') = ANY($3))
              AND (NOT $4 OR r.avg_hr IS NOT NULL)
              AND (NOT $5 OR r.avg_speed_kmh IS NOT NULL)
              AND ($6::text IS NULL OR (r.started_at IS NOT NULL
                    AND to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') >= $6))
              AND ($7::text IS NULL OR (r.started_at IS NOT NULL
                    AND to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= $7))
            ORDER BY r.started_at DESC NULLS LAST
            LIMIT $10
        ), sized AS (
            -- Drop the monsters outright: anything still this big after ~500 m
            -- simplification is an imported track NETWORK, not a ride, and one
            -- of them can outweigh every real line in the overview.
            SELECT class, mode, started_at, gj, length(gj) AS len
            FROM cand WHERE gj IS NOT NULL AND length(gj) <= $11
        ), budgeted AS (
            SELECT class, mode, gj,
                   SUM(len) OVER (ORDER BY started_at DESC NULLS LAST
                                  ROWS UNBOUNDED PRECEDING) AS running
            FROM sized
        )
        SELECT class, mode, gj::json AS geometry
        FROM budgeted WHERE running <= $12
        "#,
    )
    .bind(&[] as &[Uuid]) // $1 unused; keeps the bind slots aligned with dingonav_heat_features
    .bind(hf.map(|f| f.classes.clone()))
    .bind(hf.map(|f| f.modes.clone()))
    .bind(hf.is_some_and(|f| f.require_hr))
    .bind(hf.is_some_and(|f| f.require_speed))
    .bind(hf.and_then(|f| f.date_from.clone()))
    .bind(hf.and_then(|f| f.date_to.clone()))
    .bind(privacy)
    .bind(serde_json::to_string(region).map_err(internal)?)
    .bind(OVERVIEW_HEAT_FEATURE_CAP)
    .bind(OVERVIEW_HEAT_FEATURE_MAX_BYTES)
    .bind(OVERVIEW_HEAT_TOTAL_BYTES)
    .bind(buffer_m)
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let geometry: Option<serde_json::Value> = r.get("geometry");
            geometry.map(|g| {
                serde_json::json!({
                    "type": "Feature",
                    "properties": {
                        "class": r.get::<String, _>("class"),
                        "mode": r.get::<String, _>("mode"),
                        "overview": true,
                    },
                    "geometry": g,
                })
            })
        })
        .collect())
}

/// [minLon, minLat, maxLon, maxLat] of the selection, or None if no geometry.
async fn selection_bbox(pool: &PgPool, ids: &[Uuid], privacy: bool) -> Result<Option<[f64; 4]>, ApiError> {
    let row = sqlx::query(
        r#"
        -- Extent of the PRIVACY-TRIMMED geometry, so a home-anchored ride's
        -- home corner never widens the basemap/tile corridor (audit M1).
        SELECT ST_XMin(e) AS x0, ST_YMin(e) AS y0, ST_XMax(e) AS x1, ST_YMax(e) AS y1
        FROM (
            SELECT ST_Extent(
                CASE WHEN $2 THEN
                    ST_Difference(cleaned_geometry,
                        COALESCE((SELECT ST_Union(boundary) FROM privacy_zones),
                                 ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)))
                ELSE cleaned_geometry END
            )::geometry AS e
            FROM rides
            WHERE id = ANY($1) AND cleaned_geometry IS NOT NULL AND superseded_by IS NULL
        ) s
        "#,
    )
    .bind(ids)
    .bind(privacy)
    .fetch_one(pool)
    .await
    .map_err(internal)?;
    let x0: Option<f64> = row.get("x0");
    match (x0, row.get::<Option<f64>, _>("y0"), row.get::<Option<f64>, _>("x1"), row.get::<Option<f64>, _>("y1")) {
        (Some(x0), Some(y0), Some(x1), Some(y1)) => Ok(Some([x0, y0, x1, y1])),
        _ => Ok(None),
    }
}

/// The track-following corridor of a selection: a ~1.5 km buffer polygon
/// around the privacy-trimmed ride geometry. `geojson` feeds SQL clips,
/// `pmtiles extract --region` files, and the UI preview; `poly` is the same
/// shape parsed once for in-process tile-bounds tests; `bbox` is its envelope
/// (already buffered — no extra margin needed).
pub(crate) struct Corridor {
    pub(crate) geojson: serde_json::Value,
    pub(crate) poly: geo::MultiPolygon<f64>,
    pub(crate) bbox: [f64; 4],
}

/// Build the corridor polygon in PostGIS. The ride collection is simplified
/// (~100 m) before the geography buffer so it stays cheap at 29k-ride scale,
/// and the buffer polygon is simplified after so region files / SQL clips /
/// the UI preview carry hundreds of vertices, not hundreds of thousands.
/// Privacy cuts the zone out of the BUFFERED polygon, not the source lines:
/// differencing the lines first shatters home-crossing rides into thousands
/// of fragments whose buffer OOM-kills PostGIS, and the 1.5 km buffer bled
/// back over the zone anyway — the polygon hole actually excludes its tiles.
/// The CTEs are MATERIALIZED because the final SELECT references `poly` five
/// times and an inlined CTE re-runs the whole buffer pipeline per reference.
/// None = no usable geometry (callers fall back to the rect bbox path).
async fn selection_corridor(
    pool: &PgPool,
    ids: &[Uuid],
    privacy: bool,
) -> Result<Option<Corridor>, ApiError> {
    let row = sqlx::query(
        r#"
        WITH g AS MATERIALIZED (
            SELECT ST_Collect(cleaned_geometry) AS geom
            FROM rides
            WHERE id = ANY($1) AND cleaned_geometry IS NOT NULL AND superseded_by IS NULL
        ), c AS MATERIALIZED (
            -- Snap + dedupe before buffering: local-lap selections stack the
            -- same trail dozens of times, and GEOS unioning all those
            -- overlapping buffer rings dominated the query (~6 s for a 6-ride
            -- lap pack; ~1 s with the stack collapsed to the shared 100 m
            -- grid). quad_segs 2 is plenty for a 1.5 km buffer that gets
            -- simplified to ~100 m right after anyway.
            SELECT ST_Multi(ST_MakeValid(ST_SimplifyPreserveTopology(
                ST_Buffer(
                    ST_RemoveRepeatedPoints(ST_SnapToGrid(
                        ST_SimplifyPreserveTopology(geom, 0.001), 0.001), 0.001)::geography,
                    $3, 2)::geometry,
                0.001))) AS poly
            FROM g
            WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
        ), p AS MATERIALIZED (
            SELECT CASE WHEN $2 THEN
                ST_Multi(ST_CollectionExtract(ST_Difference(poly,
                    COALESCE((SELECT ST_Union(boundary) FROM privacy_zones),
                             ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326))), 3))
            ELSE poly END AS poly
            FROM c
        )
        SELECT ST_AsGeoJSON(poly, 5)::json AS poly,
               ST_XMin(poly) AS x0, ST_YMin(poly) AS y0,
               ST_XMax(poly) AS x1, ST_YMax(poly) AS y1
        FROM p
        WHERE poly IS NOT NULL AND NOT ST_IsEmpty(poly)
        "#,
    )
    .bind(ids)
    .bind(privacy)
    .bind(CORRIDOR_BUFFER_M)
    .fetch_optional(pool)
    .await
    .map_err(internal)?;
    let Some(row) = row else { return Ok(None) };
    let geojson: Option<serde_json::Value> = row.get("poly");
    let bbox = match (
        row.get::<Option<f64>, _>("x0"),
        row.get::<Option<f64>, _>("y0"),
        row.get::<Option<f64>, _>("x1"),
        row.get::<Option<f64>, _>("y1"),
    ) {
        (Some(x0), Some(y0), Some(x1), Some(y1)) => [x0, y0, x1, y1],
        _ => return Ok(None),
    };
    let Some(geojson) = geojson else { return Ok(None) };
    let Some(poly) = parse_multipolygon(&geojson) else { return Ok(None) };
    Ok(Some(Corridor { geojson, poly, bbox }))
}

/// How far [`HeatOverview::Local`] actually reaches: the corridor buffered by
/// [`OVERVIEW_HEAT_RADIUS_M`]. Local is the DEFAULT heat scope, and the shape
/// isn't derivable from the corridor client-side, so the estimate hands it back
/// for the map preview. Simplified hard — it's an outline, not a tile mask.
async fn heat_local_shape(
    pool: &PgPool,
    corridor: &serde_json::Value,
) -> Result<Option<serde_json::Value>, ApiError> {
    let row = sqlx::query(
        r#"
        SELECT ST_AsGeoJSON(ST_Multi(ST_MakeValid(ST_SimplifyPreserveTopology(
                   ST_Buffer(
                       ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326)::geography,
                       $2, 2)::geometry,
                   0.01))), 5)::json AS poly
        "#,
    )
    .bind(corridor.to_string())
    .bind(OVERVIEW_HEAT_RADIUS_M)
    .fetch_one(pool)
    .await
    .map_err(internal)?;
    Ok(row.get("poly"))
}

/// The zoomed-out overview region for a selection: a named boundary the
/// low-zoom map layers cover so a pack isn't blank when the rider zooms out.
pub(crate) struct OverviewRegion {
    pub(crate) name: String,
    pub(crate) geojson: serde_json::Value,
    pub(crate) poly: geo::MultiPolygon<f64>,
    pub(crate) bbox: [f64; 4],
}

/// Overview regions above this envelope area (square degrees) are skipped by
/// the ancestor walk — a continent-scale root ("Australia") makes a useless
/// zoomed-out map. NSW ≈ 120 deg²; Australia ≈ 1,400 deg².
const OVERVIEW_MAX_AREA_DEG2: f64 = 300.0;

/// Resolve the overview region for a selection envelope: the HIGHEST ancestor
/// area (walk `parent_id` up from the smallest area containing the envelope's
/// centre) whose envelope stays region-scale (≤ OVERVIEW_MAX_AREA_DEG2 —
/// continent-scale roots are skipped), unioned with the selection envelope so
/// a selection straddling the boundary keeps low-zoom coverage under its own
/// tracks. No qualifying area → the DINGO_OVERVIEW_BBOX env
/// ("minLon,minLat,maxLon,maxLat", e.g. NSW) unioned the same way; neither
/// → None (no overview layers, noted in the manifest).
async fn overview_region(
    pool: &PgPool,
    sel_bbox: [f64; 4],
) -> Result<Option<OverviewRegion>, ApiError> {
    let [x0, y0, x1, y1] = sel_bbox;
    let row = sqlx::query(
        r#"
        WITH RECURSIVE env AS (
            SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS e
        ), containing AS (
            -- Smallest area containing the selection centre…
            SELECT id FROM areas, env
            WHERE ST_Contains(boundary, ST_Centroid(env.e))
            ORDER BY ST_Area(boundary) ASC
            LIMIT 1
        ), up AS (
            -- …then walk ancestors upward…
            SELECT id, parent_id, name, 0 AS depth
            FROM areas WHERE id IN (SELECT id FROM containing)
            UNION ALL
            SELECT a.id, a.parent_id, a.name, up.depth + 1
            FROM areas a JOIN up ON a.id = up.parent_id
        )
        SELECT name, ST_AsGeoJSON(g, 5)::json AS geom,
               ST_XMin(g) AS x0, ST_YMin(g) AS y0, ST_XMax(g) AS x1, ST_YMax(g) AS y1
        FROM (
            -- …and take the highest one that's still region-scale.
            SELECT u.name, ST_Multi(ST_Union(a.boundary, (SELECT e FROM env))) AS g
            FROM up u JOIN areas a ON a.id = u.id
            WHERE ST_Area(ST_Envelope(a.boundary)) <= $5
            ORDER BY u.depth DESC
            LIMIT 1
        ) s
        "#,
    )
    .bind(x0)
    .bind(y0)
    .bind(x1)
    .bind(y1)
    .bind(OVERVIEW_MAX_AREA_DEG2)
    .fetch_optional(pool)
    .await
    .map_err(internal)?;

    if let Some(row) = row {
        let name: String = row.get("name");
        let geojson: Option<serde_json::Value> = row.get("geom");
        if let Some(geojson) = geojson {
            if let Some(poly) = parse_multipolygon(&geojson) {
                let bbox = [row.get("x0"), row.get("y0"), row.get("x1"), row.get("y1")];
                return Ok(Some(OverviewRegion { name, geojson, poly, bbox }));
            }
        }
    }

    // Fallback: a configured default region. Two rectangles as a MultiPolygon
    // (the fallback almost always contains the selection; an overlap is fine
    // for tile-cover math and pmtiles region files).
    let Ok(spec) = std::env::var("DINGO_OVERVIEW_BBOX") else { return Ok(None) };
    let nums: Vec<f64> = spec.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    let [fx0, fy0, fx1, fy1] = match nums[..] {
        [a, b, c, d] if a < c && b < d => [a, b, c, d],
        _ => return Ok(None),
    };
    let ring = |x0: f64, y0: f64, x1: f64, y1: f64| {
        vec![vec![
            vec![x0, y0], vec![x1, y0], vec![x1, y1], vec![x0, y1], vec![x0, y0],
        ]]
    };
    let geojson = serde_json::json!({
        "type": "MultiPolygon",
        "coordinates": [ring(fx0, fy0, fx1, fy1), ring(x0, y0, x1, y1)],
    });
    let Some(poly) = parse_multipolygon(&geojson) else { return Ok(None) };
    let bbox = [fx0.min(x0), fy0.min(y0), fx1.max(x1), fy1.max(y1)];
    Ok(Some(OverviewRegion { name: "overview".into(), geojson, poly, bbox }))
}

/// [minLon, minLat, maxLon, maxLat] → a GeoJSON Polygon geometry.
fn bbox_polygon(b: [f64; 4]) -> serde_json::Value {
    serde_json::json!({
        "type": "Polygon",
        "coordinates": [[
            [b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]],
        ]],
    })
}

/// GeoJSON geometry value → geo::MultiPolygon (a bare Polygon is wrapped).
fn parse_multipolygon(v: &serde_json::Value) -> Option<geo::MultiPolygon<f64>> {
    let gj: geojson::Geometry = serde_json::from_value(v.clone()).ok()?;
    match geo::Geometry::<f64>::try_from(gj).ok()? {
        geo::Geometry::MultiPolygon(mp) => Some(mp),
        geo::Geometry::Polygon(p) => Some(geo::MultiPolygon(vec![p])),
        _ => None,
    }
}

/// Protomaps publishes one planet archive per day at
/// `https://build.protomaps.com/<YYYYMMDD>.pmtiles` and keeps only about a
/// week of them, so a pinned date quietly starts 404ing a few days after it's
/// written — and a dead source means every bundle ships with NO basemap at
/// all (the extract fails, the note lands in the manifest, the rider finds out
/// on the trail). Any build.protomaps.com URL is therefore treated as "newest
/// daily build", whatever date is written in the env var.
const PROTOMAPS_BUILD_HOST: &str = "build.protomaps.com";
/// Days to walk back before giving up. Protomaps keeps ~7; today's build may
/// not be published yet, so the walk always starts one day early in practice.
const PROTOMAPS_MAX_LOOKBACK: i64 = 14;

fn protomaps_build_url(date: chrono::NaiveDate) -> String {
    format!("https://{PROTOMAPS_BUILD_HOST}/{}.pmtiles", date.format("%Y%m%d"))
}

/// True when `pmtiles` can read the archive's header. For a remote URL this is
/// the same range read `pmtiles extract` opens with, so a source that passes
/// here is one an extract can actually use.
fn pmtiles_readable(src: &str) -> bool {
    std::process::Command::new("pmtiles")
        .arg("show")
        .arg(src)
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Newest Protomaps daily build that answers, probed backwards from today.
/// Cached per UTC day so it costs one probe run a day rather than one per
/// export; a failed resolve isn't cached, so recovery needs no restart.
fn resolve_protomaps_build() -> Result<String, String> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(chrono::NaiveDate, String)>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let today = chrono::Utc::now().date_naive();
    if let Some((day, url)) = cache.lock().ok().and_then(|g| g.clone()) {
        if day == today {
            return Ok(url);
        }
    }
    for back in 0..PROTOMAPS_MAX_LOOKBACK {
        let url = protomaps_build_url(today - chrono::Duration::days(back));
        if pmtiles_readable(&url) {
            if let Ok(mut guard) = cache.lock() {
                *guard = Some((today, url.clone()));
            }
            return Ok(url);
        }
    }
    Err(format!(
        "no Protomaps daily build answered in the last {PROTOMAPS_MAX_LOOKBACK} days \
         (newest tried: {}) — check network access to {PROTOMAPS_BUILD_HOST}",
        protomaps_build_url(today)
    ))
}

/// Resolve a PMTiles source env var: a local file path or an http(s) URL —
/// `pmtiles extract` range-reads remote archives, so pointing at the global
/// Protomaps daily build makes corridor extracts work anywhere in the world.
/// build.protomaps.com URLs re-resolve to the newest live build (the dates
/// expire; see [`resolve_protomaps_build`]).
fn pmtiles_src(var: &str) -> Result<String, String> {
    match std::env::var(var) {
        Ok(s) if s.contains(PROTOMAPS_BUILD_HOST) => resolve_protomaps_build(),
        Ok(s) if s.starts_with("http://") || s.starts_with("https://") => Ok(s),
        Ok(s) if Path::new(&s).is_file() => Ok(s),
        Ok(s) => Err(format!("{var} is not a file or URL: {s}")),
        Err(_) => Err(format!("{var} not set")),
    }
}

/// [`pmtiles_bounds`] memoised per source. The probe is a network round trip
/// for remote archives and both the dialog's preflight and every extract want
/// it; sources don't change under a running daemon. `None` (unreadable /
/// unparseable) is cached too — it degrades to "treat as covering", and the
/// extract still reports the real error.
fn pmtiles_bounds_cached(src: &str) -> Option<[f64; 4]> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Option<[f64; 4]>>>,
    > = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(src).copied()) {
        return hit;
    }
    let bounds = pmtiles_bounds(src);
    if let Ok(mut c) = cache.lock() {
        c.insert(src.to_string(), bounds);
    }
    bounds
}

/// Coverage bounds of a PMTiles source (local or remote), from `pmtiles show`:
/// `bounds: (long: A, lat: B) (long: C, lat: D)` → [A, B, C, D]. None = could
/// not determine (treat as covering; the extract itself will surface errors).
fn pmtiles_bounds(src: &str) -> Option<[f64; 4]> {
    let out = std::process::Command::new("pmtiles").arg("show").arg(src).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.trim_start().starts_with("bounds:"))?;
    let nums: Vec<f64> = line
        .split(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.'))
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    (nums.len() == 4).then(|| [nums[0], nums[1], nums[2], nums[3]])
}

/// True when the corridor bbox is entirely outside the source's coverage — an
/// extract would still "succeed" but contain only the global low-zoom tiles,
/// which reads as "the map has no data except zoomed way out" on the device.
fn outside_coverage(b: [f64; 4], src: &str) -> Option<String> {
    let sb = pmtiles_bounds_cached(src)?;
    (b[2] < sb[0] || b[0] > sb[2] || b[3] < sb[1] || b[1] > sb[3]).then(|| {
        format!(
            "corridor is outside the source's coverage (({:.2},{:.2})–({:.2},{:.2})) — point the env var at a wider extract or the global Protomaps build URL",
            sb[0], sb[1], sb[2], sb[3]
        )
    })
}

/// Preflight one PMTiles-backed map layer for the export dialog: configured,
/// readable, and covering the selection? A dead source (an expired Protomaps
/// build, a moved local file) used to surface only as a note on a bundle that
/// was already on the phone — this reports it before anything gets built.
fn source_status(var: &str, bbox: Option<[f64; 4]>) -> serde_json::Value {
    let src = match pmtiles_src(var) {
        Ok(s) => s,
        Err(note) => return serde_json::json!({ "ok": false, "note": note }),
    };
    if pmtiles_bounds_cached(&src).is_none() {
        return serde_json::json!({
            "ok": false,
            "note": format!("{var} could not be read: {src}"),
        });
    }
    match bbox.and_then(|b| outside_coverage(b, &src)) {
        Some(note) => serde_json::json!({ "ok": false, "note": note }),
        None => serde_json::json!({ "ok": true, "source": src }),
    }
}

/// Shell out to `pmtiles extract`. Coverage shape: a corridor polygon
/// (written to a scratch GeoJSON file for `--region`) when given, else the
/// legacy rect — bbox + corridor margin. Best-effort: any failure returns
/// (None, Some(reason)) so the bundle still ships without the layer.
fn extract_pmtiles(
    scratch: &Path,
    out_name: &str,
    env_var: &str,
    bbox: [f64; 4],
    region: Option<&serde_json::Value>,
    minzoom: Option<u32>,
    maxzoom: u32,
) -> (Option<PathBuf>, Option<String>) {
    let src = match pmtiles_src(env_var) {
        Ok(s) => s,
        Err(e) => return (None, Some(e)),
    };
    if let Some(note) = outside_coverage(bbox, &src) {
        return (None, Some(note));
    }
    let out = scratch.join(out_name);
    let shape_arg = match region {
        Some(geom) => {
            let region_path = scratch.join(format!("{out_name}.region.geojson"));
            if let Err(e) = std::fs::write(&region_path, geom.to_string()) {
                return (None, Some(format!("could not write region file: {e}")));
            }
            format!("--region={}", region_path.display())
        }
        // The corridor polygon is pre-buffered; only the rect adds the margin.
        None => format!(
            "--bbox={},{},{},{}",
            bbox[0] - CORRIDOR_BUFFER_DEG,
            bbox[1] - CORRIDOR_BUFFER_DEG,
            bbox[2] + CORRIDOR_BUFFER_DEG,
            bbox[3] + CORRIDOR_BUFFER_DEG,
        ),
    };
    let mut cmd = std::process::Command::new("pmtiles");
    cmd.arg("extract").arg(&src).arg(&out).arg(&shape_arg).arg(format!("--maxzoom={maxzoom}"));
    if let Some(z) = minzoom {
        cmd.arg(format!("--minzoom={z}"));
    }
    match cmd.output() {
        Ok(o) if o.status.success() && out.is_file() => (Some(out), None),
        Ok(o) => (None, Some(format!("pmtiles extract failed: {}", cli_error(&o)))),
        Err(e) => (None, Some(format!("pmtiles CLI not runnable: {e}"))),
    }
}

/// Failure text from a `pmtiles` run. The Go CLI logs its errors to STDOUT,
/// not stderr, so reading stderr alone produced the useless "pmtiles extract
/// failed: " — the one message that would have said "HTTP error: 404" arrived
/// blank. Prefer stderr (in case a future version uses it), fall back to
/// stdout, and keep the last line: the log prefix is timestamp noise and the
/// real cause is at the end.
fn cli_error(out: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr);
    let text = if text.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { text };
    match text.trim().lines().next_back() {
        Some(line) if !line.is_empty() => {
            // Drop the "2026/07/21 03:32:11 main.go:185: " log prefix.
            line.split_once(": ").map_or(line, |(_, rest)| rest).trim().to_string()
        }
        _ => format!("exited with {}", out.status),
    }
}

/// Corridor/rect basemap extract (Protomaps vector tiles to z15). With an
/// overview region, the output is THREE zoom-disjoint extracts merged into one
/// `basemap.pmtiles` — region z0–7 for zoomed-out context, the selection rect
/// + margin for z8–10, and coverage-shaped z11–15 detail. Any overview step
/// failing degrades to the plain single extract so the bundle never loses its
/// detail basemap to overview trouble.
fn extract_basemap(
    scratch: &Path,
    bbox: Option<[f64; 4]>,
    region: Option<&serde_json::Value>,
    overview: Option<&OverviewRegion>,
) -> (Option<PathBuf>, Option<String>) {
    let Some(b) = bbox else {
        return (None, Some("no selection geometry for basemap bbox".into()));
    };
    let single =
        || extract_pmtiles(scratch, "basemap.pmtiles", "DINGO_BASEMAP_PMTILES", b, region, None, 15);
    let Some(ov) = overview else { return single() };

    // Region z0–7, local rect z8–10, coverage-shaped z11–15. Each tier falls
    // back to the single full-range extract rather than shipping a zoom gap.
    let tiers = [
        ("basemap-overview.pmtiles", ov.bbox, Some(&ov.geojson), 0, OVERVIEW_BASEMAP_MAXZOOM),
        (
            "basemap-local.pmtiles",
            [
                b[0] - LOCAL_BASEMAP_MARGIN_DEG,
                b[1] - LOCAL_BASEMAP_MARGIN_DEG,
                b[2] + LOCAL_BASEMAP_MARGIN_DEG,
                b[3] + LOCAL_BASEMAP_MARGIN_DEG,
            ],
            None,
            LOCAL_BASEMAP_ZMIN,
            LOCAL_BASEMAP_ZMAX,
        ),
        ("basemap-detail.pmtiles", b, region, LOCAL_BASEMAP_ZMAX + 1, 15),
    ];
    let mut parts: Vec<PathBuf> = Vec::with_capacity(tiers.len());
    for (name, tier_bbox, tier_region, zmin, zmax) in tiers {
        let (path, note) = extract_pmtiles(
            scratch,
            name,
            "DINGO_BASEMAP_PMTILES",
            tier_bbox,
            tier_region,
            Some(zmin),
            zmax,
        );
        let Some(path) = path else {
            let (p, _) = single();
            return (
                p,
                Some(format!(
                    "tiered basemap skipped at z{zmin}–{zmax} ({}), corridor-only basemap",
                    note.unwrap_or_default()
                )),
            );
        };
        parts.push(path);
    }

    let out = scratch.join("basemap.pmtiles");
    match std::process::Command::new("pmtiles")
        .arg("merge")
        .args(&parts)
        .arg(&out)
        .output()
    {
        Ok(o) if o.status.success() && out.is_file() => (Some(out), None),
        _ => {
            // Merge failed: ship the detail extract alone, re-cut across the
            // full zoom range so low zooms aren't missing entirely.
            let (p, _n) = single();
            (p, Some("pmtiles merge failed, corridor-only basemap".into()))
        }
    }
}

/// Corridor/rect terrarium-DEM hillshade extract (to z12). Mirrors
/// [`extract_basemap`]; best-effort, reported in the manifest.
fn extract_hillshade(
    scratch: &Path,
    bbox: Option<[f64; 4]>,
    region: Option<&serde_json::Value>,
) -> (Option<PathBuf>, Option<String>) {
    let Some(b) = bbox else {
        return (None, Some("no selection geometry for hillshade bbox".into()));
    };
    extract_pmtiles(scratch, "hillshade.pmtiles", "DINGO_HILLSHADE_PMTILES", b, region, None, 12)
}

/// Shared reqwest client for ESRI World Imagery fetches.
fn esri_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Dingo/satellite-export")
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("build reqwest client")
    })
}

/// One ESRI World Imagery tile. Ok(None) = upstream has no tile there (404 or
/// a 200 with a non-image body — deep zooms run out over the bush); Err(()) =
/// network/server trouble that should count toward the give-up streak. ESRI's
/// tile path is `/{z}/{y}/{x}` — row before column, unlike the XYZ
/// `/{z}/{x}/{y}` we cap by.
async fn fetch_esri_tile(z: u32, x: u32, y: u32) -> Result<Option<Vec<u8>>, ()> {
    let url = format!(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
    );
    match esri_http().get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.bytes().await {
            // JPEG/PNG magic — ESRI can answer 200 with a JSON error blob.
            Ok(b) if b.starts_with(&[0xFF, 0xD8]) || b.starts_with(&[0x89, 0x50]) => {
                Ok(Some(b.to_vec()))
            }
            Ok(_) => Ok(None),
            Err(_) => Err(()),
        },
        Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => Ok(None),
        _ => Err(()),
    }
}

/// How many ESRI tile requests fly at once. Publish time is dominated by
/// this fetch, and one-at-a-time meant one RTT per tile; 8 concurrent keeps
/// well under anything ESRI would call abusive while cutting the wall clock
/// close to 8x.
const SAT_FETCH_CONCURRENCY: usize = 8;

/// Fetch a batch of ESRI tiles, SAT_FETCH_CONCURRENCY at a time, bailing
/// after 12 consecutive failures in request order (dead upstream / offline)
/// — the same abort semantics the old sequential loop had, judged
/// chunk-by-chunk.
async fn fetch_sat_batch(
    coords: Vec<(u32, u32, u32)>,
    abort_note: &'static str,
) -> (CorridorTiles, Option<&'static str>) {
    let mut tiles = Vec::new();
    let mut streak = 0;
    for chunk in coords.chunks(SAT_FETCH_CONCURRENCY) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|&(z, x, y)| tokio::spawn(fetch_esri_tile(z, x, y)))
            .collect();
        for (&(z, x, y), handle) in chunk.iter().zip(handles) {
            match handle.await {
                Ok(Ok(Some(b))) => {
                    tiles.push((z, x, y, b));
                    streak = 0;
                }
                _ => {
                    streak += 1;
                    if streak >= 12 {
                        return (tiles, Some(abort_note));
                    }
                }
            }
        }
    }
    (tiles, None)
}

/// Fetch ESRI World Imagery for a bundle: corridor tiles (z12–zmax) plus the
/// z0–11 overview pyramid over the selection rect, so zooming out to frame the
/// whole track never goes blank. Best-effort like Strava: caps tile counts,
/// bails on a wall of upstream failures, degrades to empty offline. Returns
/// (tiles as (z,x,y,jpeg), manifest note).
async fn fetch_corridor_satellite(
    bbox: Option<[f64; 4]>,
    poly: Option<&geo::MultiPolygon<f64>>,
    buffer_deg: f64,
    zmax: u32,
) -> (CorridorTiles, Option<serde_json::Value>) {
    let Some(b) = bbox else {
        return (Vec::new(), Some(serde_json::json!({ "error": "no selection geometry" })));
    };
    let zmax = zmax.clamp(SAT_ZMIN, SAT_ZMAX);
    let (mut coords, effective_max, capped) =
        corridor_tiles(b, poly, buffer_deg, SAT_ZMIN, zmax, SAT_TILE_CAP);
    let requested = coords.len();
    // Overview pyramid over the whole rect (no corridor clip — the point is a
    // solid backdrop with the track framed on screen), appended after the
    // corridor tiles so they keep priority under the fetch-abort logic; the
    // zoom bands are disjoint, so no dedup is needed.
    let (ov_coords, ov_effective_max, ov_capped) =
        corridor_tiles(b, None, buffer_deg, 0, OVERVIEW_SAT_ZMAX, OVERVIEW_SAT_CAP);
    let ov_requested = ov_coords.len();
    coords.extend(ov_coords);
    let (tiles, aborted) =
        fetch_sat_batch(coords, "satellite tiles unavailable (upstream errors)").await;

    let detail_included = tiles.iter().filter(|(z, _, _, _)| *z >= SAT_ZMIN).count();
    let note = serde_json::json!({
        "requested": requested,
        "included": detail_included,
        "zmin": SAT_ZMIN,
        "zmax": effective_max,
        "capped": capped,
        "aborted": aborted,
        "coverage": if poly.is_some() { "corridor" } else { "rect" },
        "overview": {
            "requested": ov_requested,
            "included": tiles.len() - detail_included,
            "zmin": 0,
            "zmax": ov_effective_max,
            "capped": ov_capped,
        },
        "attribution": ESRI_ATTRIBUTION,
    });
    (tiles, Some(note))
}

/// Fetch corridor Strava tiles through the shared proxy/cache — plus, with an
/// overview region, a coarse z8–10 region-wide set appended AFTER the corridor
/// tiles so the corridor keeps priority under the fetch-abort logic (the zoom
/// bands are disjoint, so no dedup is needed). Returns the tiles plus a
/// manifest note (requested/included/capped/aborted/overview). Degrades to empty.
type CorridorTiles = Vec<(u32, u32, u32, Vec<u8>)>;

/// Bake the ride (blue) + hike (purple) Strava corridor tiles for a selection,
/// straight from the harvested MBTiles archives and colourised the same way the
/// live `/api/heat` route does — no Strava contact, no cookies. Same coords as
/// before (corridor + optional overview region); returns `(ride, hike, note)`.
/// Empty/unharvested tiles are skipped, so out-of-coverage areas bake nothing.
async fn fetch_corridor_strava(
    bbox: Option<[f64; 4]>,
    poly: Option<&geo::MultiPolygon<f64>>,
    buffer_deg: f64,
    overview: Option<&OverviewRegion>,
) -> (CorridorTiles, CorridorTiles, Option<serde_json::Value>) {
    let Some(b) = bbox else {
        return (Vec::new(), Vec::new(), Some(serde_json::json!({ "error": "no selection geometry" })));
    };
    let (mut coords, effective_max, capped) =
        corridor_tiles(b, poly, buffer_deg, STRAVA_ZMIN, STRAVA_ZMAX, STRAVA_TILE_CAP);
    let requested = coords.len();
    let (ov_requested, ov_capped) = match overview {
        Some(ov) => {
            let (ov_coords, _, ov_capped) = corridor_tiles(
                ov.bbox,
                Some(&ov.poly),
                0.0,
                OVERVIEW_STRAVA_ZMIN,
                OVERVIEW_STRAVA_ZMAX,
                OVERVIEW_STRAVA_CAP,
            );
            let n = ov_coords.len();
            coords.extend(ov_coords);
            (n, ov_capped)
        }
        None => (0, false),
    };
    // SQLite reads + PNG colourise are blocking; the corridor+overview is capped.
    let (ride, hike) = tokio::task::spawn_blocking(move || {
        let bake = |owner: &str| -> CorridorTiles {
            let mut out = Vec::new();
            for &(z, x, y) in &coords {
                if let Ok(Some(gray)) = dingo_harvest::worker::read_owner_tile(owner, z, x, y) {
                    if let Ok(rgba) = super::heat::colourise(&gray, owner) {
                        out.push((z, x, y, rgba));
                    }
                }
            }
            out
        };
        (bake("strava-ride"), bake("strava-hike"))
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), Vec::new()));
    let count_at = |ts: &CorridorTiles, pred: fn(u32) -> bool| ts.iter().filter(|(z, _, _, _)| pred(*z)).count();
    let overview_note = overview.map(|ov| {
        serde_json::json!({
            "region": ov.name,
            "requested": ov_requested,
            "ride_included": count_at(&ride, |z| z <= OVERVIEW_STRAVA_ZMAX),
            "hike_included": count_at(&hike, |z| z <= OVERVIEW_STRAVA_ZMAX),
            "zmin": OVERVIEW_STRAVA_ZMIN,
            "zmax": OVERVIEW_STRAVA_ZMAX,
            "capped": ov_capped,
        })
    });
    let note = serde_json::json!({
        "requested": requested,
        "ride_included": count_at(&ride, |z| z >= STRAVA_ZMIN),
        "hike_included": count_at(&hike, |z| z >= STRAVA_ZMIN),
        "zmin": STRAVA_ZMIN,
        "zmax": effective_max,
        "capped": capped,
        "coverage": if poly.is_some() { "corridor" } else { "rect" },
        "overview": overview_note,
    });
    (ride, hike, Some(note))
}

/// Lon/lat bounds of a web-mercator tile, as a geo Rect.
fn tile_bounds(z: u32, x: u32, y: u32) -> geo::Rect<f64> {
    let n = (1u32 << z) as f64;
    let lon = |x: f64| x / n * 360.0 - 180.0;
    let lat = |y: f64| {
        let t = std::f64::consts::PI * (1.0 - 2.0 * y / n);
        t.sinh().atan().to_degrees()
    };
    geo::Rect::new(
        geo::coord! { x: lon(x as f64), y: lat((y + 1) as f64) },
        geo::coord! { x: lon((x + 1) as f64), y: lat(y as f64) },
    )
}

/// Web-mercator tile coverage for a lon/lat bbox across [zmin, zmax], buffered
/// by `buffer_deg`, capped at `cap` tiles by trimming the deepest zooms first.
/// With `poly` set, only tiles whose bounds intersect the polygon survive —
/// the track-following corridor keeps deep zooms an L-shaped ride's bbox cover
/// would have lost to the cap. Pass `buffer_deg = 0.0` with a polygon (it is
/// pre-buffered); `CORRIDOR_BUFFER_DEG` for the legacy rect mode.
/// Returns (tiles, effective_max_zoom, was_capped).
fn corridor_tiles(
    bbox: [f64; 4],
    poly: Option<&geo::MultiPolygon<f64>>,
    buffer_deg: f64,
    zmin: u32,
    zmax: u32,
    cap: usize,
) -> (Vec<(u32, u32, u32)>, u32, bool) {
    use geo::Intersects as _;
    let [x0, y0, x1, y1] = bbox;
    let (min_lon, min_lat) = (x0 - buffer_deg, y0 - buffer_deg);
    let (max_lon, max_lat) = (x1 + buffer_deg, y1 + buffer_deg);

    let lon2x = |lon: f64, z: u32| ((lon + 180.0) / 360.0 * (1u32 << z) as f64).floor() as i64;
    let lat2y = |lat: f64, z: u32| {
        let r = lat.to_radians();
        ((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0 * (1u32 << z) as f64)
            .floor() as i64
    };
    // Per-zoom bbox tile range, clamped to the tile grid.
    let range = |z: u32| {
        let n = 1i64 << z;
        let clamp = |v: i64| v.clamp(0, n - 1) as u32;
        // y grows southward, so max_lat gives the smaller y.
        (
            (clamp(lon2x(min_lon, z)), clamp(lon2x(max_lon, z))),
            (clamp(lat2y(max_lat, z)), clamp(lat2y(min_lat, z))),
        )
    };

    // Build per-zoom, then trim from the deepest zoom down until under the cap.
    let mut by_zoom: Vec<(u32, Vec<(u32, u32, u32)>)> = Vec::new();
    let mut effective_max = zmax;
    let mut capped = false;
    match poly {
        None => {
            for z in zmin..=zmax {
                let ((xa, xb), (ya, yb)) = range(z);
                let mut tiles = Vec::new();
                for x in xa..=xb {
                    for y in ya..=yb {
                        tiles.push((z, x, y));
                    }
                }
                by_zoom.push((z, tiles));
            }
        }
        Some(p) => {
            // Quadtree descent instead of testing every bbox tile at every
            // zoom: a tile's children exactly partition it, so a tile that
            // misses the polygon prunes its whole subtree. Zooms are
            // enumerated shallow-to-deep so that once the running total
            // exhausts the cap, the deeper zooms — which the trim loop below
            // would drop anyway, and which hold ~all the tiles — are never
            // enumerated at all. Together orders of magnitude fewer polygon
            // tests than the per-zoom sweep on a 900 km corridor (which took
            // a minute-plus per call). Plain Intersects, not Relate — Relate
            // builds a full topology graph per test and is ~100x dearer.
            let mut total = 0usize;
            'zoom: for z in zmin..=zmax {
                // The shallowest zoom is always kept (the trim loop never pops
                // the last entry); deeper zooms only fit within what the cap
                // has left.
                let budget = if z == zmin { usize::MAX } else { cap.saturating_sub(total) };
                let mut tiles = Vec::new();
                let mut stack: Vec<(u32, u32, u32)> = Vec::new();
                {
                    let ((xa, xb), (ya, yb)) = range(0);
                    for x in xa..=xb {
                        for y in ya..=yb {
                            stack.push((0, x, y));
                        }
                    }
                }
                while let Some((tz, x, y)) = stack.pop() {
                    if !p.intersects(&tile_bounds(tz, x, y).to_polygon()) {
                        continue;
                    }
                    if tz == z {
                        let ((xa, xb), (ya, yb)) = range(z);
                        if x >= xa && x <= xb && y >= ya && y <= yb {
                            if tiles.len() >= budget {
                                // This zoom can't fit; it and everything
                                // deeper would be trimmed — stop here.
                                capped = true;
                                effective_max = z - 1;
                                break 'zoom;
                            }
                            tiles.push((z, x, y));
                        }
                        continue;
                    }
                    let ((xa, xb), (ya, yb)) = range(tz + 1);
                    for cx in (2 * x)..=(2 * x + 1) {
                        for cy in (2 * y)..=(2 * y + 1) {
                            if cx >= xa && cx <= xb && cy >= ya && cy <= yb {
                                stack.push((tz + 1, cx, cy));
                            }
                        }
                    }
                }
                // The sweep enumerated x-then-y in order; the descent doesn't.
                // Restore it so fetch priority and truncation stay deterministic.
                tiles.sort_unstable();
                total += tiles.len();
                by_zoom.push((z, tiles));
            }
        }
    }

    let mut total: usize = by_zoom.iter().map(|(_, t)| t.len()).sum();
    while total > cap && by_zoom.len() > 1 {
        let (z, dropped) = by_zoom.pop().unwrap();
        total -= dropped.len();
        capped = true;
        effective_max = z.saturating_sub(1);
    }
    let mut coords: Vec<(u32, u32, u32)> = by_zoom.into_iter().flat_map(|(_, t)| t).collect();
    // Absolute cap: even the single shallowest zoom can exceed `cap` on a very
    // wide selection ("Select all" spans a country). Without this, the export
    // would fire tens of thousands of sequential authenticated Strava fetches
    // (audit M5). Truncate hard and flag it.
    if coords.len() > cap {
        coords.truncate(cap);
        capped = true;
    }
    (coords, effective_max, capped)
}

/// Assemble the .dingonav zip in memory. PNG/JPEG/PMTiles are already
/// compressed, so they're stored; bundle.json is deflated.
fn build_dingonav_zip(
    bundle_json: &[u8],
    basemap: Option<&Path>,
    hillshade: Option<&Path>,
    strava_ride: &[(u32, u32, u32, Vec<u8>)],
    strava_hike: &[(u32, u32, u32, Vec<u8>)],
    satellite: &[(u32, u32, u32, Vec<u8>)],
) -> anyhow::Result<Vec<u8>> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let deflate: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let store: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        zip.start_file("bundle.json", deflate)?;
        zip.write_all(bundle_json)?;

        let store_file = |zip: &mut zip::ZipWriter<_>, name: &str, path: &Path| -> anyhow::Result<()> {
            let mut f = std::fs::File::open(path)?;
            let mut contents = Vec::new();
            f.read_to_end(&mut contents)?;
            zip.start_file(name, store)?;
            zip.write_all(&contents)?;
            Ok(())
        };
        if let Some(bm) = basemap {
            store_file(&mut zip, "basemap.pmtiles", bm)?;
        }
        if let Some(hs) = hillshade {
            store_file(&mut zip, "hillshade.pmtiles", hs)?;
        }

        for (z, x, y, bytes) in strava_ride {
            zip.start_file(format!("strava-ride/{z}/{x}/{y}.png"), store)?;
            zip.write_all(bytes)?;
        }
        for (z, x, y, bytes) in strava_hike {
            zip.start_file(format!("strava-hike/{z}/{x}/{y}.png"), store)?;
            zip.write_all(bytes)?;
        }
        for (z, x, y, bytes) in satellite {
            zip.start_file(format!("satellite/{z}/{x}/{y}.jpg"), store)?;
            zip.write_all(bytes)?;
        }
        zip.finish()?;
    }
    Ok(buf.into_inner())
}

/// Percent-encode a JSON value for a response header (header-safe subset).
fn percent_encode_json(v: &serde_json::Value) -> String {
    serde_json::to_string(v)
        .unwrap_or_default()
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | ':' | ',' | '{' | '}' | '"' | '.' | '-' => {
                c.to_string()
            }
            other => format!("%{:02X}", other as u32),
        })
        .collect()
}

async fn run_build(
    pool: &PgPool,
    body: &ExportRequest,
    bundle_dir: &Path,
    profile: Profile,
    layout: Layout,
) -> Result<Manifest, ApiError> {
    let opts = BundleOptions {
        include_tracks: body.include_tracks,
        include_heatmap: body.include_heatmap,
        profile,
        layout,
        simplify_m: None,
        // Everything leaving via the daemon is privacy-trimmed; the CLI has
        // the personal-use --no-privacy escape hatch.
        privacy: body.privacy,
    };
    build_bundle(pool, &body.ride_ids, bundle_dir, &opts)
        .await
        .map_err(|e| bad_request(e.to_string()))
}

/// Manifest summary for the download path, squeezed into a response header
/// (the body is the zip). Percent-encode so it stays header-safe.
fn urlencode_manifest(m: &Manifest) -> String {
    let json = serde_json::to_string(&serde_json::json!({
        "files": m.files.len(),
        "skipped": m.skipped.len(),
        "total_bytes": m.total_bytes,
    }))
    .unwrap_or_default();
    json.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | ':' | ',' | '{' | '}' | '"' => c.to_string(),
            other => format!("%{:02X}", other as u32),
        })
        .collect()
}

/// Zip a directory tree (deflate), paths relative to a top-level folder named
/// after the bundle.
fn zip_dir(dir: &Path, top: &str) -> anyhow::Result<Vec<u8>> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d)? {
                let path = entry?.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let rel = path.strip_prefix(dir)?;
                    zip.start_file(
                        format!("{top}/{}", rel.to_string_lossy().replace('\\', "/")),
                        opts,
                    )?;
                    let mut f = std::fs::File::open(&path)?;
                    let mut contents = Vec::new();
                    f.read_to_end(&mut contents)?;
                    zip.write_all(&contents)?;
                }
            }
        }
        zip.finish()?;
    }
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{Coverage, LayerCoverage, corridor_tiles, parse_multipolygon, slugify};

    #[test]
    fn slugify_pack_keys() {
        assert_eq!(slugify("Singleton overnight!"), "singleton-overnight");
        assert_eq!(slugify("  Menai  "), "menai");
        assert_eq!(slugify("Central Coast"), "central-coast");
        assert_eq!(slugify("日本語"), "share"); // nothing ascii-alphanumeric
        assert_eq!(slugify("a".repeat(80).as_str()).len(), 48);
        assert!(!slugify("trailing punctuation…").ends_with('-'));
    }

    /// An L-shaped corridor near Sydney: two thin legs of a square bbox. The
    /// polygon filter must cut the tile set well below the bbox cover while
    /// keeping the deepest zoom (the bbox path loses it to the cap first).
    #[test]
    fn corridor_polygon_filter_cuts_bbox_cover() {
        // Legs ~0.02° wide along the west and south edges of a 0.5°x0.5° box.
        let l_shape = serde_json::json!({
            "type": "Polygon",
            "coordinates": [[
                [150.0, -34.0], [150.02, -34.0], [150.02, -33.52],
                [150.5, -33.52], [150.5, -33.5], [150.0, -33.5], [150.0, -34.0]
            ]]
        });
        let poly = parse_multipolygon(&l_shape).expect("valid polygon");
        let bbox = [150.0, -34.0, 150.5, -33.5];
        let cap = 600;
        let (rect_full, _, _) = corridor_tiles(bbox, None, 0.0, 11, 15, usize::MAX);
        let (_, rect_max, rect_capped) = corridor_tiles(bbox, None, 0.0, 11, 15, cap);
        let (cor_tiles, cor_max, _) = corridor_tiles(bbox, Some(&poly), 0.0, 11, 15, cap);
        assert!(
            cor_tiles.len() < rect_full.len() / 4,
            "corridor {} should be a fraction of the full bbox cover {}",
            cor_tiles.len(),
            rect_full.len()
        );
        // The bbox cover blows the cap and sheds z15 (and more); the corridor
        // fits under the same cap WITH the full zoom range intact.
        assert!(rect_capped && rect_max < 15);
        assert_eq!(cor_max, 15);
        assert!(cor_tiles.iter().any(|(z, _, _)| *z == 15));
        // Every corridor tile is inside the bbox cover set.
        let rect_set: std::collections::HashSet<_> = rect_full.into_iter().collect();
        assert!(cor_tiles.iter().all(|t| rect_set.contains(t)));
    }

    /// The quadtree descent must produce exactly what the per-zoom sweep
    /// (test every bbox tile against the polygon) produced — same tiles,
    /// same order.
    #[test]
    fn corridor_descent_matches_brute_force() {
        use geo::Intersects as _;
        let l_shape = serde_json::json!({
            "type": "Polygon",
            "coordinates": [[
                [150.0, -34.0], [150.02, -34.0], [150.02, -33.52],
                [150.5, -33.52], [150.5, -33.5], [150.0, -33.5], [150.0, -34.0]
            ]]
        });
        let poly = parse_multipolygon(&l_shape).expect("valid polygon");
        // Bbox deliberately offset from the polygon so range-clipping paths
        // (tiles outside the bbox at deep zooms) are exercised too.
        let bbox = [150.005, -33.995, 150.4, -33.505];
        let (fast, _, _) = corridor_tiles(bbox, Some(&poly), 0.0, 3, 13, usize::MAX);

        let lon2x = |lon: f64, z: u32| ((lon + 180.0) / 360.0 * (1u32 << z) as f64).floor() as i64;
        let lat2y = |lat: f64, z: u32| {
            let r = lat.to_radians();
            ((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0
                * (1u32 << z) as f64)
                .floor() as i64
        };
        let mut slow = Vec::new();
        for z in 3..=13u32 {
            let n = 1i64 << z;
            let clamp = |v: i64| v.clamp(0, n - 1) as u32;
            let (xa, xb) = (clamp(lon2x(bbox[0], z)), clamp(lon2x(bbox[2], z)));
            let (ya, yb) = (clamp(lat2y(bbox[3], z)), clamp(lat2y(bbox[1], z)));
            for x in xa..=xb {
                for y in ya..=yb {
                    if poly.intersects(&super::tile_bounds(z, x, y).to_polygon()) {
                        slow.push((z, x, y));
                    }
                }
            }
        }
        assert_eq!(fast, slow);
    }

    /// Absent blob / missing keys default every layer to corridor; explicit
    /// "rect" survives round-tripping (the packs JSONB column stores this).
    #[test]
    fn layer_coverage_serde_defaults() {
        let all_default: LayerCoverage = serde_json::from_str("{}").unwrap();
        assert_eq!(all_default.heatmap, Coverage::Corridor);
        assert_eq!(all_default.satellite, Coverage::Corridor);

        let mixed: LayerCoverage =
            serde_json::from_value(serde_json::json!({ "satellite": "rect" })).unwrap();
        assert_eq!(mixed.satellite, Coverage::Rect);
        assert_eq!(mixed.basemap, Coverage::Corridor);

        let round = serde_json::to_value(mixed).unwrap();
        assert_eq!(round["satellite"], "rect");
        assert_eq!(round["heatmap"], "corridor");
    }
}
