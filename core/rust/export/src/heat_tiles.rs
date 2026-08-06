//! `dingo export heatmap-tiles` — bake the ride library into a raster
//! density-heatmap MBTiles overlay for offline nav apps (OsmAnd, Locus).
//!
//! Colored GPX heat files (export offline / bundle) carry per-track lines but
//! no accumulation: fifty rides down one fire trail look the same as one.
//! This renderer counts DISTINCT rides per pixel and maps the count through
//! the web heatmap's orange→white-hot ramp, producing the true Strava-style
//! glow the on-screen map has, as ordinary XYZ raster tiles any offline app
//! can layer over its basemap.
//!
//! Pipeline: load every live track once (simplified to sub-pixel at the max
//! zoom; privacy zones cut out server-side with ST_Difference), then per zoom
//! build a tile → polyline-run index and render covered tiles one at a time —
//! memory stays flat no matter how large the library is. Rendering is
//! per-ride max-coverage (soft-edged stamps, so a ride contributes at most
//! 1.0 per pixel) summed across rides, i.e. anti-aliased distinct-ride
//! counts. PNGs go into a standard MBTiles (harvest's writer) with
//! `type=overlay`, which OsmAnd and Locus both read directly.

use std::collections::HashMap;
use std::path::Path;

use sqlx::types::Uuid;
use sqlx::{PgPool, Row};

use dingo_harvest::mbtiles::MbtilesWriter;
use dingo_harvest::tiles::{bbox_intersects, lonlat_to_tile, tile_bounds};

/// Tile edge in pixels — the standard raster tile size.
const TILE: u32 = 256;

/// Stamp radius in pixels: full coverage inside `CORE`, linear falloff to 0
/// at `SOFT`. ~3px-wide lines with soft edges, matching the web core layer.
const R_CORE: f64 = 0.9;
const R_SOFT: f64 = 1.9;

/// What bounds the export (mirrors export offline's scope semantics), plus
/// `Rides` for an explicit selection (the web export basket).
pub enum HeatScope {
    All,
    Area(Uuid),
    Bounds([f64; 4]),
    /// Render exactly these rides — tiles are bounded by their own extent.
    Rides(Vec<Uuid>),
}

pub struct HeatTilesOptions {
    pub scope: HeatScope,
    pub min_zoom: u32,
    pub max_zoom: u32,
    /// Only tracks of this mode (e.g. moto, mtb)
    pub mode_filter: Option<String>,
    /// Distinct-ride count that saturates to white-hot
    pub hot_at: f64,
    /// Cut privacy-zone geometry out (default on; exports-only trimming)
    pub privacy: bool,
}

impl Default for HeatTilesOptions {
    fn default() -> Self {
        Self {
            scope: HeatScope::All,
            min_zoom: 5,
            max_zoom: 14,
            mode_filter: None,
            hot_at: 15.0,
            privacy: true,
        }
    }
}

#[derive(Debug, Default)]
pub struct HeatTilesSummary {
    pub rides: usize,
    pub tiles: u64,
    pub bytes: u64,
    /// [west, south, east, north] of the rendered data
    pub bounds: [f64; 4],
}

/// One track's geometry: line parts of (lon, lat), privacy already applied.
struct Track {
    parts: Vec<Vec<(f64, f64)>>,
}

/// A slice of one track part that touches one tile: points `start..=end`.
#[derive(Clone, Copy)]
struct Run {
    ride: u32,
    part: u32,
    start: u32,
    end: u32,
}

/// Load every in-scope track once. Simplification tolerance is ~quarter-pixel
/// at `max_zoom` so no zoom we render can tell the difference; privacy zones
/// are subtracted server-side (ST_Difference splits lines at zone boundaries,
/// the raster equivalent of the GPX exports' per-point trim).
async fn load_tracks(pool: &PgPool, opts: &HeatTilesOptions) -> anyhow::Result<Vec<Track>> {
    let scope_clause = match &opts.scope {
        // `Rides` is handled by the always-present $3 id filter below, so it
        // adds no spatial clause here.
        HeatScope::All | HeatScope::Rides(_) => String::new(),
        // Interpolates only a parsed Uuid / floats — injection-safe (same
        // pattern as export offline).
        HeatScope::Area(id) => format!(
            "AND ST_Intersects(r.cleaned_geometry, (SELECT boundary FROM areas WHERE id = '{id}'))"
        ),
        HeatScope::Bounds([a, b, c, d]) => format!(
            "AND ST_Intersects(r.cleaned_geometry, ST_MakeEnvelope({a}, {b}, {c}, {d}, 4326))"
        ),
    };
    let ride_filter: Option<Vec<Uuid>> = match &opts.scope {
        HeatScope::Rides(ids) => Some(ids.clone()),
        _ => None,
    };

    // Ground metres per pixel at the equator for max_zoom, /4 for headroom.
    let tol_m = 156_543.0 / f64::from(1u32 << opts.max_zoom.min(22)) / 4.0;
    let tol_deg = tol_m / 111_320.0;

    let query = format!(
        r#"
        WITH z AS (SELECT ST_Union(boundary) AS b FROM privacy_zones)
        SELECT ST_AsGeoJSON(
                 CASE WHEN $1 AND (SELECT b FROM z) IS NOT NULL
                      THEN ST_Difference(g.geom, (SELECT b FROM z))
                      ELSE g.geom END, 6) AS gj,
               g.mode
        FROM (
            SELECT ST_SimplifyPreserveTopology(r.cleaned_geometry, $2) AS geom,
                   r.mode::text AS mode
            FROM rides r
            WHERE r.cleaned_geometry IS NOT NULL
              AND ST_NPoints(r.cleaned_geometry) >= 2
              AND r.superseded_by IS NULL
              AND r.track_type <> 'route'
              AND r.kind = 'recorded'
              AND ($3::uuid[] IS NULL OR r.id = ANY($3))
              {scope_clause}
        ) g
        "#,
    );

    let rows = sqlx::query(&query)
        .bind(opts.privacy)
        .bind(tol_deg)
        .bind(&ride_filter)
        .fetch_all(pool)
        .await?;

    let mut tracks = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(m) = &opts.mode_filter {
            if !row.get::<String, _>("mode").eq_ignore_ascii_case(m) {
                continue;
            }
        }
        let Some(gj) = row.get::<Option<String>, _>("gj") else { continue };
        let parts = geojson_line_parts(&gj);
        if !parts.is_empty() {
            tracks.push(Track { parts });
        }
    }
    Ok(tracks)
}

/// Extract line parts from a GeoJSON geometry. ST_Difference can hand back
/// LineString, MultiLineString, or (fully inside a zone) an empty geometry —
/// anything without ≥2-point lines yields no parts.
fn geojson_line_parts(gj: &str) -> Vec<Vec<(f64, f64)>> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(gj) else {
        return Vec::new();
    };
    let coords_to_part = |coords: &serde_json::Value| -> Option<Vec<(f64, f64)>> {
        let arr = coords.as_array()?;
        let part: Vec<(f64, f64)> = arr
            .iter()
            .filter_map(|p| {
                let p = p.as_array()?;
                Some((p.first()?.as_f64()?, p.get(1)?.as_f64()?))
            })
            .collect();
        (part.len() >= 2).then_some(part)
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("LineString") => v
            .get("coordinates")
            .and_then(|c| coords_to_part(c))
            .into_iter()
            .collect(),
        Some("MultiLineString") => v
            .get("coordinates")
            .and_then(|c| c.as_array())
            .map(|lines| lines.iter().filter_map(coords_to_part).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Web-mercator global pixel coordinates at zoom `z` (256px tiles).
fn lonlat_to_px(lon: f64, lat: f64, z: u32) -> (f64, f64) {
    let n = f64::from(1u32 << z) * f64::from(TILE);
    let x = (lon + 180.0) / 360.0 * n;
    let lat = lat.clamp(-dingo_harvest::tiles::MAX_LAT, dingo_harvest::tiles::MAX_LAT);
    let r = lat.to_radians();
    let y = (1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0 * n;
    (x, y)
}

/// Index all track geometry into per-tile point runs for one zoom level.
/// Consecutive points in the same tile extend a run; every tile a segment's
/// bbox touches gets the pair, so lines crossing tile corners aren't clipped.
fn build_tile_index(tracks: &[Track], z: u32) -> HashMap<(u32, u32), Vec<Run>> {
    let mut index: HashMap<(u32, u32), Vec<Run>> = HashMap::new();
    let mut push = |tile: (u32, u32), ride: u32, part: u32, i: u32| {
        let runs = index.entry(tile).or_default();
        match runs.last_mut() {
            // Extend the previous run when this segment continues it.
            Some(r) if r.ride == ride && r.part == part && r.end >= i => {
                r.end = r.end.max(i + 1);
            }
            _ => runs.push(Run { ride, part, start: i, end: i + 1 }),
        }
    };
    for (ride_idx, track) in tracks.iter().enumerate() {
        for (part_idx, part) in track.parts.iter().enumerate() {
            for i in 0..part.len() - 1 {
                let (lon0, lat0) = part[i];
                let (lon1, lat1) = part[i + 1];
                let (x0, y0) = lonlat_to_tile(lon0, lat0, z);
                let (x1, y1) = lonlat_to_tile(lon1, lat1, z);
                for tx in x0.min(x1)..=x0.max(x1) {
                    for ty in y0.min(y1)..=y0.max(y1) {
                        push((tx, ty), ride_idx as u32, part_idx as u32, i as u32);
                    }
                }
            }
        }
    }
    index
}

/// Per-tile render state, reused across tiles to avoid reallocation.
struct Canvas {
    /// Σ over rides of per-pixel max coverage (0..=1 each)
    accum: Vec<f32>,
    /// Current ride's max coverage, epoch-tagged so it needs no clearing
    ride_cov: Vec<f32>,
    epoch: Vec<u32>,
    current_epoch: u32,
}

impl Canvas {
    fn new() -> Self {
        let n = (TILE * TILE) as usize;
        Self { accum: vec![0.0; n], ride_cov: vec![0.0; n], epoch: vec![0; n], current_epoch: 0 }
    }

    fn reset(&mut self) {
        self.accum.fill(0.0);
        // ride_cov/epoch reset lazily via epoch bumps
    }

    /// Stamp a soft-edged disc into the CURRENT ride's coverage (max, not add).
    fn stamp(&mut self, cx: f64, cy: f64) {
        let x0 = ((cx - R_SOFT).floor().max(0.0)) as i64;
        let y0 = ((cy - R_SOFT).floor().max(0.0)) as i64;
        let x1 = ((cx + R_SOFT).ceil().min(f64::from(TILE) - 1.0)) as i64;
        let y1 = ((cy + R_SOFT).ceil().min(f64::from(TILE) - 1.0)) as i64;
        for py in y0..=y1 {
            for px in x0..=x1 {
                let d = ((f64::from(px as i32) + 0.5 - cx).powi(2)
                    + (f64::from(py as i32) + 0.5 - cy).powi(2))
                .sqrt();
                let w = if d <= R_CORE {
                    1.0
                } else if d < R_SOFT {
                    ((R_SOFT - d) / (R_SOFT - R_CORE)) as f32
                } else {
                    continue;
                };
                let i = (py * i64::from(TILE) + px) as usize;
                if self.epoch[i] != self.current_epoch {
                    self.epoch[i] = self.current_epoch;
                    self.ride_cov[i] = 0.0;
                }
                if w > self.ride_cov[i] {
                    self.ride_cov[i] = w;
                }
            }
        }
    }

    /// Draw one line segment (tile-local pixel coords) into the current ride.
    fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64) {
        let len = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
        let steps = (len / 0.6).ceil().max(1.0) as usize;
        for s in 0..=steps {
            let t = s as f64 / steps as f64;
            self.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        }
    }

    /// Fold the current ride's coverage into the accumulator and start the
    /// next ride.
    fn next_ride(&mut self) {
        if self.current_epoch > 0 {
            for i in 0..self.accum.len() {
                if self.epoch[i] == self.current_epoch {
                    self.accum[i] += self.ride_cov[i];
                }
            }
        }
        self.current_epoch += 1;
    }
}

/// The web heatmap's palette carried into raster: deep orange at one ride
/// ramping to white-hot at `hot_at` distinct rides (log-scaled, like the
/// on-screen additive blend saturates).
fn colorize(accum: f32, hot_at: f64) -> [u8; 4] {
    if accum <= 0.001 {
        return [0, 0, 0, 0];
    }
    let t = ((1.0 + f64::from(accum)).ln() / (1.0 + hot_at).ln()).clamp(0.0, 1.0);
    // Color stops: (255,90,30) → (255,140,45) → (255,220,150) → white
    let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
    let (r, g, b) = if t < 0.5 {
        let u = t / 0.5;
        (255.0, lerp(90.0, 160.0, u), lerp(30.0, 60.0, u))
    } else {
        let u = (t - 0.5) / 0.5;
        (255.0, lerp(160.0, 255.0, u), lerp(60.0, 255.0, u))
    };
    // Sub-pixel coverage fades alpha; a single full ride sits at ~0.62.
    let a = (f64::from(accum.min(1.0)) * (0.55 + 0.45 * t)).min(1.0);
    [r as u8, g as u8, b as u8, (a * 255.0) as u8]
}

/// Encode a rendered canvas to PNG; `None` when the tile came out empty.
fn encode_png(canvas: &Canvas, hot_at: f64) -> anyhow::Result<Option<Vec<u8>>> {
    let mut rgba = vec![0u8; (TILE * TILE * 4) as usize];
    let mut any = false;
    for (i, &a) in canvas.accum.iter().enumerate() {
        let px = colorize(a, hot_at);
        if px[3] > 0 {
            any = true;
            rgba[i * 4..i * 4 + 4].copy_from_slice(&px);
        }
    }
    if !any {
        return Ok(None);
    }
    let mut out = Vec::new();
    let enc = image::codecs::png::PngEncoder::new(&mut out);
    image::ImageEncoder::write_image(enc, &rgba, TILE, TILE, image::ExtendedColorType::Rgba8)?;
    Ok(Some(out))
}

/// Build the MBTiles. Renders zoom by zoom, tile by tile; an existing file at
/// `out` is replaced (bundles are regenerable artifacts).
pub async fn build_heat_mbtiles(
    pool: &PgPool,
    out: &Path,
    opts: &HeatTilesOptions,
    mut progress: impl FnMut(u32, u64, u64),
) -> anyhow::Result<HeatTilesSummary> {
    anyhow::ensure!(opts.min_zoom <= opts.max_zoom, "min zoom must be <= max zoom");
    anyhow::ensure!(opts.max_zoom <= 16, "max zoom capped at 16 (tile counts explode beyond)");

    let tracks = load_tracks(pool, opts).await?;
    anyhow::ensure!(!tracks.is_empty(), "no tracks in scope — nothing to render");

    let mut bounds = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for t in &tracks {
        for part in &t.parts {
            for &(lon, lat) in part {
                bounds[0] = bounds[0].min(lon);
                bounds[1] = bounds[1].min(lat);
                bounds[2] = bounds[2].max(lon);
                bounds[3] = bounds[3].max(lat);
            }
        }
    }

    // The scope also bounds the TILES rendered, not just which rides are
    // loaded — otherwise a small --bounds still renders every selected ride's
    // full extent (a ride crossing the box can span half the state). In-scope
    // rides still draw whole within the kept tiles.
    let scope_bbox = match &opts.scope {
        // `All` and `Rides` are data-driven: every indexed tile is covered by a
        // selected/loaded ride, so there's nothing extra to clip.
        HeatScope::All | HeatScope::Rides(_) => None,
        HeatScope::Bounds(b) => Some(*b),
        HeatScope::Area(id) => {
            let row = sqlx::query(
                "SELECT ST_XMin(e) AS w, ST_YMin(e) AS s, ST_XMax(e) AS e, ST_YMax(e) AS n
                 FROM (SELECT ST_Extent(boundary) AS e FROM areas WHERE id = $1) x",
            )
            .bind(id)
            .fetch_one(pool)
            .await?;
            Some([row.get("w"), row.get("s"), row.get("e"), row.get("n")])
        }
    };
    if let Some(sb) = scope_bbox {
        // Metadata bounds reflect actual coverage: data clamped to the scope.
        bounds = [
            bounds[0].max(sb[0]),
            bounds[1].max(sb[1]),
            bounds[2].min(sb[2]),
            bounds[3].min(sb[3]),
        ];
    }

    if out.exists() {
        std::fs::remove_file(out)?;
    }
    let writer = MbtilesWriter::open(
        out,
        "Dingo heatmap",
        "Ride-density heatmap rendered from the Dingo library",
        bounds,
    )?;

    let mut summary =
        HeatTilesSummary { rides: tracks.len(), bounds, ..Default::default() };
    let mut canvas = Canvas::new();

    for z in opts.min_zoom..=opts.max_zoom {
        let mut index = build_tile_index(&tracks, z);
        if let Some(sb) = scope_bbox {
            index.retain(|&(tx, ty), _| bbox_intersects(tile_bounds(z, tx, ty), sb));
        }
        let total = index.len() as u64;
        let mut done = 0u64;
        for (&(tx, ty), runs) in &index {
            canvas.reset();
            let origin_x = f64::from(tx) * f64::from(TILE);
            let origin_y = f64::from(ty) * f64::from(TILE);
            // Runs arrive grouped by ride (the index walks rides in order);
            // fold coverage into the accumulator at each ride boundary.
            let mut current_ride = u32::MAX;
            for run in runs {
                if run.ride != current_ride {
                    canvas.next_ride();
                    current_ride = run.ride;
                }
                let part = &tracks[run.ride as usize].parts[run.part as usize];
                for i in run.start..run.end {
                    let (lon0, lat0) = part[i as usize];
                    let (lon1, lat1) = part[i as usize + 1];
                    let (gx0, gy0) = lonlat_to_px(lon0, lat0, z);
                    let (gx1, gy1) = lonlat_to_px(lon1, lat1, z);
                    canvas.line(gx0 - origin_x, gy0 - origin_y, gx1 - origin_x, gy1 - origin_y);
                }
            }
            canvas.next_ride(); // fold the last ride
            if let Some(png) = encode_png(&canvas, opts.hot_at)? {
                writer.put(z, tx, ty, &png)?;
                summary.tiles += 1;
                summary.bytes += png.len() as u64;
            }
            done += 1;
            if done % 500 == 0 {
                progress(z, done, total);
            }
        }
        progress(z, total, total);
    }

    writer.refresh_zoom_meta()?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(points: Vec<(f64, f64)>) -> Track {
        Track { parts: vec![points] }
    }

    #[test]
    fn geojson_parsing_handles_difference_outputs() {
        let ls = r#"{"type":"LineString","coordinates":[[151.0,-33.0],[151.1,-33.1]]}"#;
        assert_eq!(geojson_line_parts(ls).len(), 1);
        let mls = r#"{"type":"MultiLineString","coordinates":[[[151.0,-33.0],[151.1,-33.1]],[[151.2,-33.2],[151.3,-33.3]]]}"#;
        assert_eq!(geojson_line_parts(mls).len(), 2);
        // Empty difference results and degenerate 1-point parts vanish
        let empty = r#"{"type":"MultiLineString","coordinates":[]}"#;
        assert!(geojson_line_parts(empty).is_empty());
        let point = r#"{"type":"MultiLineString","coordinates":[[[151.0,-33.0]]]}"#;
        assert!(geojson_line_parts(point).is_empty());
    }

    #[test]
    fn pixel_projection_matches_tile_math() {
        // A point's global pixel / 256 must land in lonlat_to_tile's tile.
        for &(lon, lat, z) in &[(151.21, -33.87, 10u32), (151.3, -33.3, 14), (-0.1, 51.5, 8)] {
            let (px, py) = lonlat_to_px(lon, lat, z);
            let (tx, ty) = lonlat_to_tile(lon, lat, z);
            assert_eq!((px / 256.0).floor() as u32, tx, "x at z{z}");
            assert_eq!((py / 256.0).floor() as u32, ty, "y at z{z}");
        }
    }

    #[test]
    fn tile_index_covers_corner_crossings() {
        // A segment whose endpoints sit in diagonal tiles must also cover the
        // tiles its bbox spans (corner-cutting lines aren't dropped).
        let z = 14;
        let a = (151.001, -33.001);
        let b = (151.05, -33.05);
        let idx = build_tile_index(&[track(vec![a, b])], z);
        let (ax, ay) = lonlat_to_tile(a.0, a.1, z);
        let (bx, by) = lonlat_to_tile(b.0, b.1, z);
        for tx in ax.min(bx)..=ax.max(bx) {
            for ty in ay.min(by)..=ay.max(by) {
                assert!(idx.contains_key(&(tx, ty)), "missing tile {tx},{ty}");
            }
        }
    }

    #[test]
    fn distinct_rides_accumulate_but_one_ride_saturates_at_one() {
        let mut c = Canvas::new();
        // One ride drawing the same line twice → coverage stays ≤ 1
        c.next_ride();
        c.line(10.0, 10.0, 40.0, 10.0);
        c.line(10.0, 10.0, 40.0, 10.0);
        c.next_ride();
        let i = 10 * TILE as usize + 25;
        assert!(c.accum[i] <= 1.0 + f32::EPSILON, "single ride must cap at 1.0");
        // A second ride on the same path doubles it
        c.line(10.0, 10.0, 40.0, 10.0);
        c.next_ride();
        assert!(c.accum[i] > 1.5, "two rides must accumulate, got {}", c.accum[i]);
    }

    #[test]
    fn colorize_ramps_to_white_hot() {
        assert_eq!(colorize(0.0, 15.0), [0, 0, 0, 0]);
        let one = colorize(1.0, 15.0);
        assert!(one[3] > 120, "single ride clearly visible, got alpha {}", one[3]);
        let hot = colorize(20.0, 15.0);
        assert_eq!(&hot[..3], &[255, 255, 255], "saturated count renders white");
    }
}
