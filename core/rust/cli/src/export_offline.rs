//! `dingo export offline` — build an offline GPX bundle for a ride area so
//! the heatmap and plans can be loaded into an offline nav app (OsmAnd,
//! Locus) on the bike.
//!
//! Output (into `<out>/<Area>/` when an area is given, else `<out>/`):
//!   heatmap_own.gpx    own recorded tracks, merged, orange   (#FF822D)
//!   heatmap_other.gpx  other people's tracks, merged, red    (#FF2D46)
//!   heatmap_plan.gpx   plan-classed non-route tracks, blue   (#468CFF)
//!   Plans/<Name>.gpx   one navigable file per plan (route), blue, full res
//!   Routes/<Collection>/<Name>.gpx  planned routes (curated networks), each
//!                      with its stored color and route description, full res
//!   POIs.gpx           waypoints in scope (fuel/camp/water/…), Garmin syms
//!
//! Class rules and colors match the web heatmap exactly (`/api/heatmap`,
//! `web/src/components/Map/heatmapLayers.ts`). Colors are embedded three
//! ways per file — bare `<color>`, `gpx_style:line`, and `osmand:color` —
//! so OsmAnd (old and new) and Locus all honor them; each app ignores the
//! dialects it doesn't know. Merged heatmap geometries are simplified
//! (default 5 m) to keep the nav app responsive with hundreds of tracks;
//! plan files stay full resolution since they're navigated individually.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use sqlx::types::Uuid;
use sqlx::{PgPool, Row};

use dingo_export::{
    COLOR_OTHER, COLOR_OWN, COLOR_PLAN, RideGpx, gpx_close, gpx_open, gpx_track, ride_point_segments, sanitize,
    sanitize_filename,
};

#[derive(Debug, Default)]
pub struct OfflineExportSummary {
    pub dest: PathBuf,
    pub own_tracks: usize,
    pub other_tracks: usize,
    pub plan_tracks: usize,
    pub plan_files: usize,
    pub route_files: usize,
    pub poi_count: usize,
    pub skipped_no_geom: usize,
    pub total_bytes: u64,
}

/// What bounds the export.
pub enum Scope {
    All,
    Area { id: Uuid, name: String },
    Bounds([f64; 4]),
}

/// Resolve an `--area` argument that may be a UUID or a (case-insensitive)
/// area name.
pub async fn resolve_area(pool: &PgPool, arg: &str) -> anyhow::Result<(Uuid, String)> {
    if let Ok(id) = Uuid::parse_str(arg) {
        let row = sqlx::query("SELECT name FROM areas WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        if let Some(row) = row {
            return Ok((id, row.get("name")));
        }
        anyhow::bail!("Area not found: {arg}");
    }
    let rows = sqlx::query("SELECT id, name FROM areas WHERE lower(name) = lower($1)")
        .bind(arg)
        .fetch_all(pool)
        .await?;
    match rows.len() {
        0 => anyhow::bail!("Area not found: {arg} (try `dingo area list`)"),
        1 => Ok((rows[0].get("id"), rows[0].get("name"))),
        _ => anyhow::bail!("Area name '{arg}' is ambiguous — use the UUID"),
    }
}

/// Parse `--bounds minLon,minLat,maxLon,maxLat`.
pub fn parse_bounds(s: &str) -> anyhow::Result<[f64; 4]> {
    let parts: Vec<f64> = s
        .split(',')
        .filter_map(|p| p.trim().parse().ok())
        .collect();
    match <[f64; 4]>::try_from(parts) {
        Ok(b) if b[0] < b[2] && b[1] < b[3] => Ok(b),
        _ => anyhow::bail!("--bounds must be minLon,minLat,maxLon,maxLat"),
    }
}

/// A collision-free `<dir>/<base>.gpx` path, deduped only against paths from
/// THIS run — unlike organize's unique_path, existing files are overwritten,
/// so re-exporting refreshes the bundle instead of stacking `_2` copies.
fn plan_path(dir: &Path, base: &str, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let mut candidate = dir.join(format!("{base}.gpx"));
    let mut n = 2;
    while taken.contains(&candidate) {
        candidate = dir.join(format!("{base}_{n}.gpx"));
        n += 1;
    }
    taken.insert(candidate.clone());
    candidate
}

/// One track selected for export.
struct TrackRow {
    id: Uuid,
    name: Option<String>,
    day: Option<String>,
    class: String,
    is_route: bool,
    is_planned: bool,
    collection: Option<String>,
    color: Option<String>,
    description: Option<String>,
}

/// Run the export. `simplify_m` applies to merged heatmap files only.
pub async fn run(
    pool: &PgPool,
    out: &Path,
    scope: &Scope,
    simplify_m: f64,
    mode_filter: Option<&str>,
    privacy: bool,
) -> anyhow::Result<OfflineExportSummary> {
    let mut summary = OfflineExportSummary::default();

    // Same shape as /api/heatmap: dynamic clause interpolates only floats and
    // a parsed Uuid, both injection-safe.
    let scope_clause = match scope {
        Scope::All => String::new(),
        Scope::Area { id, .. } => format!(
            "AND ST_Intersects(r.cleaned_geometry, (SELECT boundary FROM areas WHERE id = '{id}'))"
        ),
        Scope::Bounds([a, b, c, d]) => format!(
            "AND ST_Intersects(r.cleaned_geometry, ST_MakeEnvelope({a}, {b}, {c}, {d}, 4326))"
        ),
    };

    let query = format!(
        r#"
        SELECT r.id, r.name, r.mode::text AS mode,
               to_char(r.started_at, 'YYYY-MM-DD') AS day,
               r.track_type = 'route' AS is_route,
               r.kind = 'planned' AS is_planned,
               r.collection, r.color, r.description,
               CASE
                   WHEN r.kind = 'planned' THEN 'plan'
                   WHEN r.origin = 'other' THEN 'other'
                   WHEN r.track_type = 'route'
                        OR r.started_at IS NULL THEN 'plan'
                   ELSE 'own'
               END AS class
        FROM rides r
        WHERE r.cleaned_geometry IS NOT NULL
          AND ST_NPoints(r.cleaned_geometry) >= 2
          AND r.superseded_by IS NULL
          {scope_clause}
        ORDER BY r.started_at ASC NULLS LAST
        "#,
    );

    let tracks: Vec<TrackRow> = sqlx::query(&query)
        .fetch_all(pool)
        .await?
        .into_iter()
        .filter(|row| {
            mode_filter.is_none_or(|m| row.get::<String, _>("mode").eq_ignore_ascii_case(m))
        })
        .map(|row| TrackRow {
            id: row.get("id"),
            name: row.get("name"),
            day: row.get("day"),
            class: row.get("class"),
            is_route: row.get("is_route"),
            is_planned: row.get("is_planned"),
            collection: row.get("collection"),
            color: row.get("color"),
            description: row.get("description"),
        })
        .collect();

    let dest = match scope {
        Scope::Area { name, .. } => out.join(sanitize(name)),
        _ => out.to_path_buf(),
    };
    fs::create_dir_all(&dest)?;
    summary.dest = dest.clone();

    let tolerance_deg = (simplify_m.max(0.0)) / 111_320.0;

    // Every GPX this run writes, so stale files from a previous run (a now-empty
    // class, or a plan since renamed/superseded) can be pruned at the end —
    // otherwise the "refreshes the bundle" contract silently leaves orphans.
    let mut written_files: HashSet<PathBuf> = HashSet::new();

    // Merged per-class heatmap files. Routes are excluded from the merged
    // 'plan' file — they get individual navigable files below instead, so a
    // plan never appears twice in the app's track list.
    let classes: [(&str, &str, &str); 3] = [
        ("own", COLOR_OWN, "heatmap_own.gpx"),
        ("other", COLOR_OTHER, "heatmap_other.gpx"),
        ("plan", COLOR_PLAN, "heatmap_plan.gpx"),
    ];
    for (class, color, filename) in classes {
        let members: Vec<&TrackRow> = tracks
            .iter()
            .filter(|t| t.class == class && !t.is_route)
            .collect();
        if members.is_empty() {
            continue;
        }
        let doc_name = format!("Dingo heatmap — {class}");
        let mut gpx = gpx_open(&doc_name);
        let mut written = 0usize;
        for t in &members {
            let segments = ride_point_segments(pool, t.id, tolerance_deg, privacy).await?;
            if segments.is_empty() {
                summary.skipped_no_geom += 1;
                continue;
            }
            // Ride names usually already carry the date ("… on 2018-05-07")
            // — only append it when they don't.
            let name = match (&t.name, &t.day) {
                (Some(n), Some(d)) if !n.contains(d.as_str()) => format!("{n} ({d})"),
                (Some(n), _) => n.clone(),
                (None, Some(d)) => format!("Ride {d}"),
                (None, None) => "Unnamed ride".to_string(),
            };
            gpx_track(&mut gpx, &name, color, &segments);
            written += 1;
        }
        if written == 0 {
            continue;
        }
        gpx_close(&mut gpx, color);
        let path = dest.join(filename);
        fs::write(&path, &gpx)?;
        written_files.insert(path.clone());
        summary.total_bytes += gpx.len() as u64;
        match class {
            "own" => summary.own_tracks = written,
            "other" => summary.other_tracks = written,
            _ => summary.plan_tracks = written,
        }
    }

    // Individual plan (route) files — full resolution, one per plan, so a
    // single plan can be selected and followed in the app. Built by
    // build_ride_gpx (not ride_points) so elevation from the time series —
    // cleaned_geometry is 2D — plus time/HR make it into the file.
    // Planned routes (curated networks) go under Routes/<Collection>/ with
    // their stored color and description; drawn plans stay in Plans/.
    let plans_dir = dest.join("Plans");
    let routes_dir = dest.join("Routes");
    let mut taken: HashSet<PathBuf> = HashSet::new();
    for t in tracks.iter().filter(|t| t.is_route) {
        let name = t.name.as_deref().unwrap_or("Unnamed plan");
        let color = t
            .color
            .as_deref()
            .map(|c| c.trim_start_matches('#'))
            .unwrap_or(COLOR_PLAN);
        let RideGpx::Gpx(gpx) = dingo_export::build_ride_gpx(
            pool,
            t.id,
            name,
            Some(color),
            privacy,
            t.description.as_deref(),
        )
        .await?
        else {
            summary.skipped_no_geom += 1;
            continue;
        };

        let dir = if t.is_planned {
            match &t.collection {
                Some(c) => routes_dir.join(sanitize(c)),
                None => routes_dir.clone(),
            }
        } else {
            plans_dir.clone()
        };
        fs::create_dir_all(&dir)?;
        let path = plan_path(&dir, &sanitize_filename(name), &mut taken);
        fs::write(&path, &gpx)?;
        written_files.insert(path.clone());
        summary.total_bytes += gpx.len() as u64;
        if t.is_planned {
            summary.route_files += 1;
        } else {
            summary.plan_files += 1;
        }
    }

    // POIs in scope, as a single waypoint file (fuel/camping/water are the
    // point of planning). Garmin syms come from the category reverse-map so
    // OsmAnd/Locus show native icons.
    let poi_scope = match scope {
        Scope::All => String::new(),
        Scope::Area { id, .. } => format!(
            "AND ST_Intersects(p.position, (SELECT boundary FROM areas WHERE id = '{id}'))"
        ),
        Scope::Bounds([a, b, c, d]) => format!(
            "AND ST_Intersects(p.position, ST_MakeEnvelope({a}, {b}, {c}, {d}, 4326))"
        ),
    };
    let poi_query = format!(
        r#"
        SELECT ST_X(p.position) AS lon, ST_Y(p.position) AS lat,
               p.elevation, p.name, p.description, p.category::text AS category
        FROM pois p
        WHERE TRUE {poi_scope}
        ORDER BY p.name
        "#,
    );
    let poi_rows = sqlx::query(&poi_query).fetch_all(pool).await?;
    let poi_path = dest.join("POIs.gpx");
    if !poi_rows.is_empty() {
        let mut gpx = dingo_export::gpx_open("Dingo POIs");
        for row in &poi_rows {
            let lon: f64 = row.get("lon");
            let lat: f64 = row.get("lat");
            let cat: String = row.get("category");
            let sym = dingo_core::poi::PoiCategory::from_db_str(&cat)
                .unwrap_or(dingo_core::poi::PoiCategory::Poi)
                .garmin_sym();
            use std::fmt::Write as _;
            let _ = write!(gpx, "  <wpt lat=\"{lat:.7}\" lon=\"{lon:.7}\">");
            if let Some(e) = row.get::<Option<f32>, _>("elevation") {
                let _ = write!(gpx, "<ele>{e:.1}</ele>");
            }
            let _ = write!(
                gpx,
                "<name>{}</name>",
                dingo_export::xml_escape(row.get::<String, _>("name").as_str())
            );
            if let Some(d) = row.get::<Option<String>, _>("description") {
                let _ = write!(gpx, "<desc>{}</desc>", dingo_export::xml_escape(&d));
            }
            let _ = writeln!(gpx, "<sym>{}</sym></wpt>", dingo_export::xml_escape(sym));
        }
        gpx.push_str("</gpx>\n");
        fs::write(&poi_path, &gpx)?;
        written_files.insert(poi_path.clone());
        summary.total_bytes += gpx.len() as u64;
        summary.poi_count = poi_rows.len();
    }

    // Prune stale outputs: heatmap files for classes that produced nothing this
    // run, and any plan GPX left from a previous run (renamed/superseded plans).
    for (_, _, filename) in classes {
        let p = dest.join(filename);
        if p.exists() && !written_files.contains(&p) {
            let _ = fs::remove_file(&p);
        }
    }
    if let Ok(entries) = fs::read_dir(&plans_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("gpx") && !written_files.contains(&p) {
                let _ = fs::remove_file(&p);
            }
        }
    }
    if poi_rows.is_empty() && poi_path.exists() && !written_files.contains(&poi_path) {
        let _ = fs::remove_file(&poi_path);
    }
    // Routes/<Collection>/ — prune stale route files (renamed/re-imported),
    // then any collection dir left empty.
    if let Ok(collections) = fs::read_dir(&routes_dir) {
        for coll in collections.flatten() {
            let dir = coll.path();
            if !dir.is_dir() {
                continue;
            }
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("gpx")
                        && !written_files.contains(&p)
                    {
                        let _ = fs::remove_file(&p);
                    }
                }
            }
            let _ = fs::remove_dir(&dir); // only succeeds when empty
        }
    }

    Ok(summary)
}
