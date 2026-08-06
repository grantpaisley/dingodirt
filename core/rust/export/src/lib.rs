//! Shared GPX export: the bundle builder behind `POST /api/export` (daemon)
//! and `dingo export bundle` (CLI), plus the GPX/path helpers the organize
//! and offline exports use.
//!
//! A *bundle* is a folder of GPX files built from an explicit ride-id list
//! (the web UI's export basket, or a CLI selection):
//!   - individual tracks: one full-resolution GPX per ride, library filenames,
//!     colored by class (own orange / other red / plan blue);
//!   - merged heatmap: heatmap_own/other/plan.gpx built from the SELECTED
//!     rides only, simplified to the profile's budget (routes excluded — they
//!     are navigable individual files, never heat).
//! Both parts are optional per call. Re-exporting into the same folder
//! overwrites it and prunes stale files: bundles are regenerable artifacts.

pub mod heat_tiles;
pub mod library;

pub use library::{TreeSummary, export_tree, place_rides, prune_empty_dirs, ride_tag};

use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::types::Uuid;
use sqlx::{PgPool, Row};

/// Web heatmap palette (RRGGBB, no '#') — matches /api/heatmap and
/// web/src/components/Map/heatmapLayers.ts.
pub const COLOR_OWN: &str = "FF822D";
pub const COLOR_OTHER: &str = "FF2D46";
pub const COLOR_PLAN: &str = "468CFF";

// ---- Path/XML helpers (shared with organize + export offline) ----

/// Replace path-hostile characters so a value is safe as a single path
/// component or filename. Keeps spaces and most punctuation (macOS/APFS only
/// forbids `/` and NUL), collapses whitespace, trims, and caps length.
pub fn sanitize(component: &str) -> String {
    let mut out = String::with_capacity(component.len());
    for ch in component.chars() {
        match ch {
            '/' | '\\' | '\0' => out.push('-'),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = out.trim_matches([' ', '.']).to_string();
    // Cap well under the 255-byte APFS limit (names are ~60 chars anyway).
    let capped: String = trimmed.chars().take(180).collect();
    if capped.is_empty() {
        "Unknown".to_string()
    } else {
        capped
    }
}

/// Sanitize a value for use as a FILENAME: same as `sanitize` but with
/// underscores for spaces (directory components keep their spaces).
pub fn sanitize_filename(component: &str) -> String {
    sanitize(component).replace(' ', "_")
}

/// XML-escape text content / attribute values.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

// ---- Colored-GPX helpers (shared with export offline) ----

/// Open a GPX document with the namespaces the color dialects need.
pub fn gpx_open(doc_name: &str) -> String {
    let mut gpx = String::with_capacity(64 * 1024);
    gpx.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    gpx.push_str(
        "<gpx version=\"1.1\" creator=\"Dingo\" \
         xmlns=\"http://www.topografix.com/GPX/1/1\" \
         xmlns:gpx_style=\"http://www.topografix.com/GPX/gpx_style/0/2\" \
         xmlns:osmand=\"https://osmand.net\">\n",
    );
    let _ = writeln!(gpx, "  <metadata><name>{}</name></metadata>", xml_escape(doc_name));
    gpx
}

/// A (lon, lat, elevation) export point.
pub type Pt = (f64, f64, Option<f64>);

/// Append one colored `<trk>`. Each segment becomes its own `<trkseg>` —
/// privacy-zone removal splits tracks into parts, and a real segment break
/// stops nav apps drawing a straight line across the gap.
pub fn gpx_track(gpx: &mut String, name: &str, color: &str, segments: &[Vec<Pt>]) {
    let _ = writeln!(gpx, "  <trk><name>{}</name>", xml_escape(name));
    let _ = writeln!(
        gpx,
        "    <extensions><color>#{color}</color>\
         <gpx_style:line><gpx_style:color>{color}</gpx_style:color></gpx_style:line>\
         </extensions>",
    );
    for points in segments {
        gpx.push_str("    <trkseg>\n");
        for (lon, lat, ele) in points {
            let _ = write!(gpx, "      <trkpt lat=\"{lat:.7}\" lon=\"{lon:.7}\">");
            if let Some(e) = ele {
                let _ = write!(gpx, "<ele>{e:.1}</ele>");
            }
            gpx.push_str("</trkpt>\n");
        }
        gpx.push_str("    </trkseg>\n");
    }
    gpx.push_str("  </trk>\n");
}

/// Close the document with the file-level color (what OsmAnd reads).
pub fn gpx_close(gpx: &mut String, color: &str) {
    let _ = writeln!(
        gpx,
        "  <extensions><color>#{color}</color><osmand:color>#{color}</osmand:color></extensions>\n</gpx>",
    );
}

/// Fetch a ride's cleaned geometry as segments of (lon, lat, ele) points,
/// optionally simplified (`tolerance_deg = 0` keeps full resolution). With
/// `privacy` on, any point inside a privacy zone (a small circle around home)
/// is dropped, splitting the track into separate segments at each gap — so an
/// exported ride starts/ends a few hundred metres from the actual door
/// instead of at it. Zones are small, so through-rides are untouched.
/// Segments shorter than 2 points are discarded.
pub async fn ride_point_segments(
    pool: &PgPool,
    id: Uuid,
    tolerance_deg: f64,
    privacy: bool,
) -> anyhow::Result<Vec<Vec<Pt>>> {
    let rows = sqlx::query(
        r#"
        WITH z AS (SELECT ST_Union(boundary) AS b FROM privacy_zones)
        SELECT (dp).path[1] AS idx,
               ST_X((dp).geom) AS lon,
               ST_Y((dp).geom) AS lat,
               ST_Z((dp).geom) AS ele,
               CASE WHEN $3 AND (SELECT b FROM z) IS NOT NULL
                    THEN ST_Intersects((dp).geom, (SELECT b FROM z))
                    ELSE FALSE END AS private
        FROM (
            SELECT ST_DumpPoints(
                CASE WHEN $2 > 0.0
                     THEN ST_SimplifyPreserveTopology(cleaned_geometry, $2)
                     ELSE cleaned_geometry END) AS dp
            FROM rides WHERE id = $1
        ) s
        ORDER BY idx
        "#,
    )
    .bind(id)
    .bind(tolerance_deg)
    .bind(privacy)
    .fetch_all(pool)
    .await?;

    let mut segments: Vec<Vec<Pt>> = Vec::new();
    let mut current: Vec<Pt> = Vec::new();
    for r in rows {
        if r.get::<bool, _>("private") {
            if current.len() >= 2 {
                segments.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
            continue;
        }
        let ele: Option<f64> = r.get("ele");
        current.push((r.get("lon"), r.get("lat"), ele.filter(|e| e.is_finite())));
    }
    if current.len() >= 2 {
        segments.push(current);
    }
    Ok(segments)
}

/// A turn-cue waypoint for GPX export.
#[derive(Debug, Clone)]
pub struct TurnWpt {
    pub lon: f64,
    pub lat: f64,
    pub name: String,
}

/// A ride's turn cues as exportable waypoints, ordered along the track.
/// Rejected junctions are skipped; with `privacy` on, cues inside a privacy
/// zone are dropped too (a named corner right by home leaks the location the
/// trimmed track just hid).
pub async fn ride_turn_wpts(pool: &PgPool, id: Uuid, privacy: bool) -> anyhow::Result<Vec<TurnWpt>> {
    let rows = sqlx::query(
        r#"
        WITH z AS (SELECT ST_Union(boundary) AS b FROM privacy_zones)
        SELECT ST_X(m.location) AS lon, ST_Y(m.location) AS lat,
               l.dir, l.onto_road
        FROM ride_turn_marks l
        JOIN turn_marks m ON m.id = l.mark_id
        WHERE l.ride_id = $1
          AND m.status = 'active'
          AND NOT ($2 AND (SELECT b FROM z) IS NOT NULL
                   AND ST_Intersects(m.location, (SELECT b FROM z)))
        ORDER BY l.dist_m
        "#,
    )
    .bind(id)
    .bind(privacy)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let dir: String = r.get("dir");
            let onto: String = r.get("onto_road");
            let name = match dir.as_str() {
                "L" => format!("L onto {onto}"),
                "R" => format!("R onto {onto}"),
                _ => format!("Continue onto {onto}"),
            };
            TurnWpt {
                lon: r.get("lon"),
                lat: r.get("lat"),
                name,
            }
        })
        .collect())
}

/// Append `<wpt>` turn cues. GPX 1.1 orders waypoints before tracks, so call
/// this right after the metadata block.
pub fn gpx_wpts(gpx: &mut String, wpts: &[TurnWpt]) {
    for w in wpts {
        let _ = writeln!(
            gpx,
            "  <wpt lat=\"{:.7}\" lon=\"{:.7}\"><name>{}</name><sym>Junction</sym></wpt>",
            w.lat,
            w.lon,
            xml_escape(&w.name)
        );
    }
}

/// Outcome of building one ride's GPX.
#[derive(Debug)]
pub enum RideGpx {
    Gpx(String),
    /// No usable cleaned geometry
    NoGeometry,
    /// Every point fell inside a privacy zone — nothing exportable remains
    FullyPrivate,
}

/// Build a full-resolution GPX 1.1 document for one ride: elevation + time +
/// Garmin TrackPointExtension HR from the cleaned time series, and (when
/// `color` is given) the same three color dialects the bundle files carry.
/// With `privacy` on, points inside a privacy zone (a small home circle) are
/// removed, splitting into separate `<trkseg>`s at each gap (per-point
/// time-series alignment is preserved — points are dropped, never renumbered).
pub async fn build_ride_gpx(
    pool: &PgPool,
    id: Uuid,
    name: &str,
    color: Option<&str>,
    privacy: bool,
    desc: Option<&str>,
) -> anyhow::Result<RideGpx> {
    let point_rows = sqlx::query(
        r#"
        WITH z AS (SELECT ST_Union(boundary) AS b FROM privacy_zones),
        points AS (
            SELECT (dp).path[1] AS idx,
                   ST_X((dp).geom) AS lon,
                   ST_Y((dp).geom) AS lat,
                   ST_Z((dp).geom) AS ele,
                   CASE WHEN $2 AND (SELECT b FROM z) IS NOT NULL
                        THEN ST_Intersects((dp).geom, (SELECT b FROM z))
                        ELSE FALSE END AS private
            FROM (SELECT ST_DumpPoints(cleaned_geometry) AS dp
                  FROM rides WHERE id = $1) s
        )
        SELECT idx, lon, lat, ele, private FROM points ORDER BY idx
        "#,
    )
    .bind(id)
    .bind(privacy)
    .fetch_all(pool)
    .await?;

    if point_rows.len() < 2 {
        return Ok(RideGpx::NoGeometry);
    }
    let public_count = point_rows
        .iter()
        .filter(|r| !r.get::<bool, _>("private"))
        .count();
    if public_count < 2 {
        return Ok(RideGpx::FullyPrivate);
    }

    let ts_row = sqlx::query("SELECT cleaned_time_series FROM rides WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    let time_series: Vec<serde_json::Value> = ts_row
        .and_then(|r| r.get::<Option<serde_json::Value>, _>("cleaned_time_series"))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();

    let mut gpx = String::with_capacity(point_rows.len() * 90);
    gpx.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    gpx.push_str(
        "<gpx version=\"1.1\" creator=\"Dingo\" \
         xmlns=\"http://www.topografix.com/GPX/1/1\" \
         xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\"",
    );
    if color.is_some() {
        gpx.push_str(
            " xmlns:gpx_style=\"http://www.topografix.com/GPX/gpx_style/0/2\" \
             xmlns:osmand=\"https://osmand.net\"",
        );
    }
    gpx.push_str(">\n");
    let _ = write!(gpx, "  <metadata><name>{}</name>", xml_escape(name));
    if let Some(d) = desc {
        let _ = write!(gpx, "<desc>{}</desc>", xml_escape(d));
    }
    gpx.push_str("</metadata>\n");
    // Turn cues ride along as waypoints (shared junction marks; empty until
    // the roads table is loaded and turns computed).
    let wpts = ride_turn_wpts(pool, id, privacy).await?;
    gpx_wpts(&mut gpx, &wpts);
    let _ = writeln!(gpx, "  <trk><name>{}</name>", xml_escape(name));
    if let Some(c) = color {
        let _ = writeln!(
            gpx,
            "    <extensions><color>#{c}</color>\
             <gpx_style:line><gpx_style:color>{c}</gpx_style:color></gpx_style:line>\
             </extensions>",
        );
    }
    // Split into <trkseg>s wherever privacy removes points; suppress
    // one-point orphan segments.
    let mut seg_open = false;
    let mut pending_close = false;
    let mut run_len = 0usize;
    // Pre-compute run lengths so 1-point runs are skipped entirely
    let private_flags: Vec<bool> = point_rows.iter().map(|r| r.get("private")).collect();

    for (i, row) in point_rows.iter().enumerate() {
        if private_flags[i] {
            if seg_open {
                pending_close = true;
            }
            continue;
        }
        // Length of the public run starting here (only computed at run starts)
        if run_len == 0 {
            run_len = private_flags[i..].iter().take_while(|p| !**p).count();
            if run_len == 1 {
                run_len = 0;
                continue; // orphan point between gaps — drop it
            }
        }
        run_len -= 1;
        if pending_close {
            gpx.push_str("  </trkseg>\n");
            seg_open = false;
            pending_close = false;
        }
        if !seg_open {
            gpx.push_str("  <trkseg>\n");
            seg_open = true;
        }

        let idx: i32 = row.get("idx");
        let lon: f64 = row.get("lon");
        let lat: f64 = row.get("lat");
        let ts_item = time_series.get((idx - 1) as usize);

        // Elevation lives in the time series: cleaned_geometry is ST_Force2D,
        // so ST_Z is always NULL and only exists as a fallback.
        let ele: Option<f64> = ts_item
            .and_then(|v| v.get("ele"))
            .and_then(|v| v.as_f64())
            .or_else(|| row.get::<Option<f64>, _>("ele"));

        let _ = write!(gpx, "    <trkpt lat=\"{lat:.7}\" lon=\"{lon:.7}\">");
        if let Some(e) = ele {
            if e.is_finite() {
                let _ = write!(gpx, "<ele>{e:.1}</ele>");
            }
        }
        if let Some(t) = ts_item.and_then(|v| v.get("time")).and_then(|v| v.as_str()) {
            let _ = write!(gpx, "<time>{}</time>", xml_escape(t));
        }
        if let Some(hr) = ts_item
            .and_then(|v| v.get("heart_rate"))
            .and_then(|v| v.as_i64())
        {
            let _ = write!(
                gpx,
                "<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{hr}</gpxtpx:hr>\
                 </gpxtpx:TrackPointExtension></extensions>"
            );
        }
        gpx.push_str("</trkpt>\n");
    }

    if seg_open {
        gpx.push_str("  </trkseg>\n");
    }
    gpx.push_str("  </trk>\n");
    match color {
        Some(c) => gpx_close(&mut gpx, c),
        None => gpx.push_str("</gpx>\n"),
    }
    Ok(RideGpx::Gpx(gpx))
}

// ---- Bundle builder ----

/// Target nav app. All profiles currently emit all three color dialects
/// (bare `<color>` + `gpx_style:line` + `osmand:color` — each app ignores
/// the ones it doesn't know; this combination is what's field-verified).
/// Profiles differ in their default heatmap simplification budget and
/// folder layout. `Dmd2` is an alias of `Generic` until color support is
/// tested on a real DMD2 device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Osmand,
    Locus,
    Dmd2,
    Generic,
}

impl Profile {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "osmand" => Some(Self::Osmand),
            "locus" => Some(Self::Locus),
            "dmd2" => Some(Self::Dmd2),
            "generic" => Some(Self::Generic),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Osmand => "osmand",
            Self::Locus => "locus",
            Self::Dmd2 => "dmd2",
            Self::Generic => "generic",
        }
    }

    /// Default merged-heatmap simplification (metres). OsmAnd chokes on very
    /// large track files (17 MB lesson), so its budget is coarser.
    pub fn default_simplify_m(&self) -> f64 {
        match self {
            Self::Osmand | Self::Dmd2 => 10.0,
            Self::Locus | Self::Generic => 5.0,
        }
    }
}

/// Folder layout for individual track files inside a bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    /// All track files directly in the bundle folder — safest: some nav apps
    /// don't browse nested track directories.
    Flat,
    /// `State/Region/` subfolders (Unknown-filled), for apps that do (Locus).
    Tree,
}

impl Layout {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "flat" => Some(Self::Flat),
            "tree" => Some(Self::Tree),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Flat => "flat",
            Self::Tree => "tree",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BundleOptions {
    pub include_tracks: bool,
    pub include_heatmap: bool,
    pub profile: Profile,
    pub layout: Layout,
    /// Merged-heatmap simplification in metres (individual tracks stay full
    /// resolution). `None` → the profile default.
    pub simplify_m: Option<f64>,
    /// Remove privacy-zone points (default everywhere; a CLI --no-privacy
    /// escape hatch exists for personal library/nav exports)
    pub privacy: bool,
}

/// One file the bundle run wrote.
#[derive(Debug, Serialize)]
pub struct ManifestFile {
    /// Relative to the bundle folder
    pub path: String,
    /// "track" | "heatmap"
    pub kind: String,
    /// Rides contributing to this file
    pub rides: usize,
    pub bytes: u64,
}

/// A requested ride the bundle could not include.
#[derive(Debug, Serialize)]
pub struct SkippedRide {
    pub id: Uuid,
    /// "not_found" | "superseded" | "no_geometry"
    pub reason: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Manifest {
    pub files: Vec<ManifestFile>,
    pub skipped: Vec<SkippedRide>,
    pub total_bytes: u64,
}

struct BundleTrack {
    id: Uuid,
    name: Option<String>,
    day: Option<String>,
    class: String,
    is_route: bool,
    state: Option<String>,
    region: Option<String>,
}

fn class_color(class: &str) -> &'static str {
    match class {
        "other" => COLOR_OTHER,
        "plan" => COLOR_PLAN,
        _ => COLOR_OWN,
    }
}

/// A collision-free `<dir>/<base>.gpx` path, deduped only against paths from
/// THIS run — existing files are overwritten, so re-exporting refreshes the
/// bundle instead of stacking `_2` copies.
fn bundle_path(dir: &Path, base: &str, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let mut candidate = dir.join(format!("{base}.gpx"));
    let mut n = 2;
    while taken.contains(&candidate) {
        candidate = dir.join(format!("{base}_{n}.gpx"));
        n += 1;
    }
    taken.insert(candidate.clone());
    candidate
}

/// Write via temp-then-rename so a failure mid-write never leaves a truncated
/// GPX in the bundle (same pattern as the ingest file store).
fn write_atomic(path: &Path, contents: &str) -> anyhow::Result<()> {
    let tmp = path.with_extension("gpx.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// True if `dir` is a folder some prior Dingo bundle owns (has a manifest.json)
/// or doesn't exist yet / is empty. Only such folders are safe to prune —
/// otherwise a first export into a name that collides with an existing synced
/// folder (e.g. OsmAnd's `rec`) would delete the user's real tracks (audit M2).
fn is_prunable_bundle_dir(dir: &Path) -> bool {
    if dir.join("manifest.json").exists() {
        return true;
    }
    match fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(), // empty
        Err(_) => true,                              // doesn't exist
    }
}

/// Remove `.gpx` files under `dir` (recursively) that this run didn't write,
/// then drop emptied subfolders — the "re-export refreshes the bundle"
/// contract. Non-GPX files are left alone. Never follows symlinks (uses the
/// dir-entry's own type), so a symlinked subfolder can't lead deletion out of
/// the bundle tree.
fn prune_stale(dir: &Path, written: &HashSet<PathBuf>) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue; // never traverse or delete through a symlink
            }
            let path = entry.path();
            if ft.is_dir() {
                dirs.push(path.clone());
                stack.push(path);
            } else if ft.is_file()
                && path.extension().and_then(|e| e.to_str()) == Some("gpx")
                && !written.contains(&path)
            {
                let _ = fs::remove_file(&path);
            }
        }
    }
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = fs::remove_dir(&d); // fails (kept) unless empty
    }
}

/// Build a bundle from an explicit ride-id list into `bundle_dir` (created if
/// missing; existing GPX not re-written this run is pruned). Also drops a
/// `manifest.json` into the bundle. Requested ids that are unknown,
/// superseded, or geometry-less are reported in `skipped`, never silently
/// dropped.
pub async fn build_bundle(
    pool: &PgPool,
    ride_ids: &[Uuid],
    bundle_dir: &Path,
    opts: &BundleOptions,
) -> anyhow::Result<Manifest> {
    let mut manifest = Manifest::default();

    let rows = sqlx::query(
        r#"
        SELECT r.id, r.name,
               to_char(r.started_at, 'YYYY-MM-DD') AS day,
               r.track_type = 'route' AS is_route,
               r.superseded_by IS NOT NULL AS superseded,
               r.cleaned_geometry IS NOT NULL
                   AND ST_NPoints(r.cleaned_geometry) >= 2 AS has_geom,
               r.state, r.region,
               CASE
                   WHEN r.origin = 'other' THEN 'other'
                   WHEN r.track_type = 'route'
                        OR r.started_at IS NULL THEN 'plan'
                   ELSE 'own'
               END AS class
        FROM rides r
        WHERE r.id = ANY($1)
        ORDER BY r.started_at ASC NULLS LAST
        "#,
    )
    .bind(ride_ids)
    .fetch_all(pool)
    .await?;

    let found: HashSet<Uuid> = rows.iter().map(|r| r.get("id")).collect();
    for id in ride_ids {
        if !found.contains(id) {
            manifest.skipped.push(SkippedRide { id: *id, reason: "not_found".into() });
        }
    }

    let mut tracks: Vec<BundleTrack> = Vec::new();
    for row in rows {
        let id: Uuid = row.get("id");
        if row.get::<bool, _>("superseded") {
            manifest.skipped.push(SkippedRide { id, reason: "superseded".into() });
            continue;
        }
        if !row.get::<bool, _>("has_geom") {
            manifest.skipped.push(SkippedRide { id, reason: "no_geometry".into() });
            continue;
        }
        tracks.push(BundleTrack {
            id,
            name: row.get("name"),
            day: row.get("day"),
            class: row.get("class"),
            is_route: row.get("is_route"),
            state: row.get("state"),
            region: row.get("region"),
        });
    }

    if tracks.is_empty() {
        anyhow::bail!(
            "nothing to export — all {} requested rides were skipped",
            ride_ids.len()
        );
    }

    // Decide prunability BEFORE we write anything (once we drop files in, the
    // folder is no longer "empty").
    let prunable = is_prunable_bundle_dir(bundle_dir);
    fs::create_dir_all(bundle_dir)?;
    let mut written: HashSet<PathBuf> = HashSet::new();
    let mut taken: HashSet<PathBuf> = HashSet::new();

    // Individual tracks: full resolution, library-style filenames, colored by
    // class. Layout::Tree nests State/Region like the library does.
    if opts.include_tracks {
        for t in &tracks {
            let name = t.name.as_deref().unwrap_or("Unnamed ride");
            let gpx = match build_ride_gpx(pool, t.id, name, Some(class_color(&t.class)), opts.privacy, None).await? {
                RideGpx::Gpx(g) => g,
                RideGpx::NoGeometry => {
                    manifest.skipped.push(SkippedRide { id: t.id, reason: "no_geometry".into() });
                    continue;
                }
                RideGpx::FullyPrivate => {
                    manifest.skipped.push(SkippedRide { id: t.id, reason: "privacy_zone".into() });
                    continue;
                }
            };
            let dir = match opts.layout {
                Layout::Flat => bundle_dir.to_path_buf(),
                Layout::Tree => bundle_dir
                    .join(sanitize(t.state.as_deref().unwrap_or("Unknown")))
                    .join(sanitize(t.region.as_deref().unwrap_or("Unknown"))),
            };
            fs::create_dir_all(&dir)?;
            let path = bundle_path(&dir, &sanitize_filename(name), &mut taken);
            write_atomic(&path, &gpx)?;
            manifest.files.push(ManifestFile {
                path: path
                    .strip_prefix(bundle_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned(),
                kind: "track".into(),
                rides: 1,
                bytes: gpx.len() as u64,
            });
            manifest.total_bytes += gpx.len() as u64;
            written.insert(path);
        }
    }

    // Merged heatmap layers from the selected rides only. Routes are excluded
    // (they're navigable individual files, and shouldn't double as heat).
    if opts.include_heatmap {
        let tolerance_deg =
            opts.simplify_m.unwrap_or_else(|| opts.profile.default_simplify_m()).max(0.0)
                / 111_320.0;
        let classes: [(&str, &str, &str); 3] = [
            ("own", COLOR_OWN, "heatmap_own.gpx"),
            ("other", COLOR_OTHER, "heatmap_other.gpx"),
            ("plan", COLOR_PLAN, "heatmap_plan.gpx"),
        ];
        for (class, color, filename) in classes {
            let members: Vec<&BundleTrack> = tracks
                .iter()
                .filter(|t| t.class == class && !t.is_route)
                .collect();
            if members.is_empty() {
                continue;
            }
            let mut gpx = gpx_open(&format!("Dingo heatmap — {class}"));
            let mut count = 0usize;
            for t in &members {
                let segments =
                    ride_point_segments(pool, t.id, tolerance_deg, opts.privacy).await?;
                if segments.is_empty() {
                    continue; // degenerate post-simplify, or fully in a privacy zone
                }
                // Ride names usually already carry the date ("… on
                // 2018-05-07") — only append it when they don't.
                let name = match (&t.name, &t.day) {
                    (Some(n), Some(d)) if !n.contains(d.as_str()) => format!("{n} ({d})"),
                    (Some(n), _) => n.clone(),
                    (None, Some(d)) => format!("Ride {d}"),
                    (None, None) => "Unnamed ride".to_string(),
                };
                gpx_track(&mut gpx, &name, color, &segments);
                count += 1;
            }
            if count == 0 {
                continue;
            }
            gpx_close(&mut gpx, color);
            let path = bundle_dir.join(filename);
            write_atomic(&path, &gpx)?;
            manifest.files.push(ManifestFile {
                path: filename.into(),
                kind: "heatmap".into(),
                rides: count,
                bytes: gpx.len() as u64,
            });
            manifest.total_bytes += gpx.len() as u64;
            written.insert(path);
        }
    }

    // Only prune folders we own (a prior Dingo bundle, or one we just created);
    // never sweep a user's existing folder we happened to be pointed at.
    if prunable {
        prune_stale(bundle_dir, &written);
    }

    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    fs::write(bundle_dir.join("manifest.json"), &manifest_json)?;

    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_roundtrip() {
        for p in [Profile::Osmand, Profile::Locus, Profile::Dmd2, Profile::Generic] {
            assert_eq!(Profile::parse(p.as_str()), Some(p));
        }
        assert_eq!(Profile::parse("nope"), None);
    }

    #[test]
    fn gpx_track_escapes_and_colors() {
        let mut gpx = gpx_open("doc & name");
        gpx_track(&mut gpx, "A <ride>", "FF822D", &[vec![(151.0, -33.0, Some(12.34)), (151.1, -33.1, None)]]);
        gpx_close(&mut gpx, "FF822D");
        assert!(gpx.contains("doc &amp; name"));
        assert!(gpx.contains("A &lt;ride&gt;"));
        assert!(gpx.contains("<gpx_style:color>FF822D</gpx_style:color>"));
        assert!(gpx.contains("<osmand:color>#FF822D</osmand:color>"));
        assert!(gpx.contains("<ele>12.3</ele>"));
        // A point without elevation must not emit an empty <ele>
        assert!(!gpx.contains("<ele></ele>"));
    }

    #[test]
    fn sanitize_filename_underscores() {
        assert_eq!(sanitize_filename("Palm Dale loop / 2020"), "Palm_Dale_loop_-_2020");
        assert_eq!(sanitize(""), "Unknown");
    }
}

#[cfg(test)]
mod split_tests {
    use super::*;

    #[test]
    fn gpx_track_multi_segment_output() {
        // Two segments (a privacy gap) → two <trkseg> in one <trk>.
        let mut gpx = gpx_open("doc");
        gpx_track(&mut gpx, "R", "FF822D", &[
            vec![(151.0, -33.0, None), (151.1, -33.1, None)],
            vec![(151.3, -33.3, None), (151.4, -33.4, None)],
        ]);
        gpx_close(&mut gpx, "FF822D");
        assert_eq!(gpx.matches("<trkseg>").count(), 2);
        assert_eq!(gpx.matches("<trk>").count(), 1);
        assert_eq!(gpx.matches("<trkpt").count(), 4);
    }

    #[test]
    fn is_prunable_only_for_owned_or_empty_dirs() {
        let base = std::env::temp_dir().join(format!("dingo-prune-test-{}", Uuid::new_v4()));
        let _ = fs::create_dir_all(&base);
        // empty → prunable
        assert!(is_prunable_bundle_dir(&base));
        // foreign file present, no manifest → NOT prunable
        fs::write(base.join("someone-elses.gpx"), b"x").unwrap();
        assert!(!is_prunable_bundle_dir(&base));
        // our manifest present → prunable again
        fs::write(base.join("manifest.json"), b"{}").unwrap();
        assert!(is_prunable_bundle_dir(&base));
        let _ = fs::remove_dir_all(&base);
    }
}
