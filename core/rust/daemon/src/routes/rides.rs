//! Rides API endpoints

use axum::{
    Json, Router,
    extract::{Extension, Path, Query},
    routing::get,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Query parameters for listing rides
#[derive(Debug, Deserialize)]
pub struct ListRidesParams {
    /// Zoom level for geometry resolution (10, 14, or full)
    pub zoom: Option<u8>,
    /// Bounding box: minLon,minLat,maxLon,maxLat
    pub bounds: Option<String>,
    /// Freehand selection polygon: semicolon-separated lon,lat pairs
    /// (e.g. "151.1,-33.9;151.2,-33.9;151.15,-33.8"). Ring is auto-closed.
    /// Matches rides inside OR crossing the polygon.
    pub polygon: Option<String>,
    /// Filter to only associated rides
    pub associated: Option<bool>,
    /// Free-text search: space-separated terms, AND'd, each a case-insensitive
    /// substring over name / state / region / LGAs / suburbs. Runs in SQL so it
    /// searches the whole library, not just the (capped) page the client holds.
    pub q: Option<String>,
    /// Restrict to specific rides (comma-separated UUIDs) — lets the client
    /// fetch a selection's rows regardless of the recency cap.
    pub ids: Option<String>,
    /// `ids` returns a lean id-only payload (no geometry/stats) for callers
    /// (lasso) that only need the matching ride ids; `meta` returns every
    /// summary field EXCEPT geometry — the whole library's metadata is small
    /// enough to filter client-side (Places tree counts).
    pub fields: Option<String>,
    /// Location-folder filters (exact match on the same keys the library tree
    /// uses: state / region / first LGA / first suburb; "Unknown" matches
    /// NULL). Combine with `fields=ids` to select a folder's rides.
    pub state: Option<String>,
    pub region: Option<String>,
    pub lga: Option<String>,
    pub suburb: Option<String>,
    /// Pagination limit
    pub limit: Option<i64>,
    /// Pagination offset
    pub offset: Option<i64>,
}

/// Ride summary for list view
#[derive(Debug, Serialize)]
pub struct RideSummary {
    pub id: Uuid,
    pub name: Option<String>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub distance_m: Option<f64>,
    pub duration_s: Option<f64>,
    /// Elapsed time minus detected stops (from the cleaned track's stop
    /// periods) — the "moving time" a Garmin would report
    pub moving_s: Option<f64>,
    pub mode: String,
    /// Track class: 'own' (recorded — has timestamps) | 'other' (someone
    /// else's, by origin tag) | 'plan' (routes / no timestamps). Anything
    /// with speed or duration data is a recording, never a plan.
    pub class: String,
    pub avg_hr: Option<f64>,
    pub max_hr: Option<f64>,
    pub avg_speed: Option<f64>,
    pub max_speed: Option<f64>,
    /// Where the track came from (wikiloc / dsra / strava / a mate's name);
    /// NULL for Grant's own pre-tagging imports
    pub source: Option<String>,
    /// Difficulty 1-5 (Grant's scale, manually assigned); NULL = ungraded
    pub grade: Option<i16>,
    /// Whose track this is (owners table); NULL only on lean id-only rows
    pub owner_id: Option<Uuid>,
    /// Owner display name ("Grant", "Fabio", "Strava global")
    pub owner: Option<String>,
    /// Majority state over the ride's track (e.g. "NSW")
    pub state: Option<String>,
    /// Curated colloquial region (e.g. "Snowy Mountains")
    pub region: Option<String>,
    /// All LGAs the ride passes through, in first-encounter order
    pub lgas: Option<Vec<String>>,
    /// All suburbs the ride passes through, in first-encounter order
    pub suburbs: Option<Vec<String>>,
    /// True = loop (start ≈ end), false = point-to-point. NULL for degenerate
    /// (<2-point) geometry. Same threshold as ride naming: endpoints within
    /// 500 m OR 2% of total length.
    pub is_loop: Option<bool>,
    /// 'recorded' | 'planned'
    pub kind: String,
    /// Planned routes: collection label ("GOAT NSW North") and display color
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub geometry: Option<serde_json::Value>,
}

/// Full ride detail
#[derive(Debug, Serialize)]
pub struct RideDetail {
    pub id: Uuid,
    pub name: Option<String>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub ended_at: Option<chrono::DateTime<chrono::Utc>>,
    pub distance_m: Option<f64>,
    pub duration_s: Option<f64>,
    pub elevation_gain: Option<f64>,
    pub elevation_loss: Option<f64>,
    pub avg_speed: Option<f64>,
    pub max_speed: Option<f64>,
    pub avg_hr: Option<f64>,
    pub max_hr: Option<f64>,
    pub condition: Option<String>,
    pub time_of_day: Option<String>,
    pub mode: String,
    /// Where the track came from (wikiloc / dsra / strava / a mate's name)
    pub source: Option<String>,
    /// Difficulty 1-5 (Grant's scale); NULL = ungraded
    pub grade: Option<i16>,
    /// Whose track this is (owners table)
    pub owner: OwnerRef,
    /// Track name from inside the source file (e.g. "Hampton ATV")
    pub original_name: Option<String>,
    /// Original filename as uploaded/ingested (files.original_name)
    pub file_name: Option<String>,
    pub imported_at: chrono::DateTime<chrono::Utc>,
    /// Source folder when genuinely known (CLI ingest/organize). NULL for web
    /// uploads — the browser only reveals the filename, and the recorded
    /// source_path is a dingo-import temp dir.
    pub imported_from: Option<String>,
    /// Where the exported GPX lives in the library tree now
    pub library_path: Option<String>,
    /// Majority state over the ride's track (e.g. "NSW")
    pub state: Option<String>,
    /// Curated colloquial region (e.g. "Snowy Mountains"), from lga_regions
    pub region: Option<String>,
    /// All LGAs the ride passes through, in first-encounter order
    pub lgas: Option<Vec<String>>,
    /// All suburbs the ride passes through, in first-encounter order
    pub suburbs: Option<Vec<String>>,
    /// 'recorded' | 'planned'
    pub kind: String,
    /// Planned routes: collection label, display color, and the source
    /// file's route description (closure notes, permit requirements)
    pub collection: Option<String>,
    pub color: Option<String>,
    pub description: Option<String>,
    /// Folder home (filter pills); NULL = Unfiled
    pub folder_id: Option<Uuid>,
    /// Labels attached to this ride (multi-membership, across all sets)
    pub label_ids: Vec<Uuid>,
    pub geometry: Option<serde_json::Value>,
    pub time_series: Option<serde_json::Value>,
}

/// Owner of a track, as shown/edited in the detail pane
#[derive(Debug, Serialize)]
pub struct OwnerRef {
    pub id: Uuid,
    pub name: String,
    /// 'me' | 'friend' | 'source' | 'synthetic'
    pub kind: String,
}

/// Best-effort "where did this file come from" folder. Web uploads land in a
/// dingo-import temp dir and the browser never reveals the real client folder,
/// so those (and NULLs) yield None — the UI says "web import".
fn imported_from_folder(source_path: Option<&str>) -> Option<String> {
    let path = source_path?;
    if path.contains("/dingo-import-") {
        return None;
    }
    std::path::Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Build rides routes
pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_rides))
        .route("/stats", get(ride_stats))
        .route("/locations", get(ride_locations))
        .route("/plan", axum::routing::post(create_plan))
        .route("/{id}", get(get_ride).patch(update_ride_mode))
        .route("/{id}/points", get(get_ride_points))
}

/// A route drawn in the web map, to be saved as a plan-class ride.
#[derive(Debug, Deserialize)]
pub struct CreatePlanRequest {
    pub name: String,
    /// Ride mode to tag the plan with (adv | enduro | mtb | watersport | other)
    pub mode: Option<String>,
    /// [lon, lat] vertices in draw order
    pub coords: Vec<[f64; 2]>,
}

/// Save a drawn route as a plan. The route is written as a GPX `<rte>` and
/// pushed through the NORMAL ingest path (content-addressed file store,
/// parser sets track_type='route'), then cleaned and located — so the plan
/// behaves exactly like an imported one everywhere downstream (list, map,
/// basket, exports, DingoNav bundles).
async fn create_plan(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<CreatePlanRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    use axum::http::StatusCode;
    use std::fmt::Write as _;

    let internal = |e: String| (StatusCode::INTERNAL_SERVER_ERROR, e);
    let bad = |m: &str| (StatusCode::BAD_REQUEST, m.to_string());

    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad("plan name must not be empty"));
    }
    if body.coords.len() < 2 || body.coords.len() > 20_000 {
        return Err(bad("plan needs between 2 and 20000 points"));
    }
    if !body.coords.iter().all(|[lon, lat]| {
        lon.is_finite() && lat.is_finite() && (-180.0..=180.0).contains(lon) && (-90.0..=90.0).contains(lat)
    }) {
        return Err(bad("coordinates out of range"));
    }
    if let Some(m) = body.mode.as_deref() {
        if !["adv", "enduro", "mtb", "watersport", "other"].contains(&m) {
            return Err(bad("unknown mode"));
        }
    }

    // GPX <rte> — the parser stores routes as track_type='route' with the
    // route name as the ride name.
    let mut gpx = String::with_capacity(body.coords.len() * 60);
    gpx.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    gpx.push_str("<gpx version=\"1.1\" creator=\"Dingo\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n");
    let _ = writeln!(gpx, "  <rte><name>{}</name>", dingo_export::xml_escape(name));
    for [lon, lat] in &body.coords {
        let _ = writeln!(gpx, "    <rtept lat=\"{lat:.7}\" lon=\"{lon:.7}\"></rtept>");
    }
    gpx.push_str("  </rte>\n</gpx>\n");

    let tmp = std::env::temp_dir().join(format!("dingo-plan-{}.gpx", Uuid::new_v4()));
    std::fs::write(&tmp, &gpx).map_err(|e| internal(e.to_string()))?;

    let config = dingo_core::Config::load().map_err(|e| internal(e.to_string()))?;
    let store = dingo_ingest::FileStore::new(&config.file_store_path)
        .map_err(|e| internal(e.to_string()))?;
    let result = dingo_ingest::ingest_file(&pool, &store, &tmp, dingo_ingest::RideOrigin::Own).await;
    let _ = std::fs::remove_file(&tmp);
    let result = result.map_err(|e| internal(e.to_string()))?;

    if result.was_duplicate || result.ride_ids.is_empty() {
        return Err((StatusCode::CONFLICT, "an identical plan already exists".into()));
    }
    let ride_id = result.ride_ids[0];

    // Clean (simplify/jitter — also what makes the plan render + export)
    dingo_geo::clean_ride(&pool, ride_id, &dingo_geo::CleaningConfig::default())
        .await
        .map_err(|e| internal(format!("plan saved but cleaning failed: {e}")))?;

    if let Some(m) = body.mode.as_deref() {
        sqlx::query("UPDATE rides SET mode = $1::ride_mode, mode_source = 'user' WHERE id = $2")
            .bind(m)
            .bind(ride_id.0)
            .execute(&pool)
            .await
            .map_err(|e| internal(e.to_string()))?;
    }

    // Locality attributes (state/region/LGAs/suburbs) so the plan shows up in
    // Places and search. Best-effort: an empty gazetteer just leaves them
    // NULL. The naming pass may generate a name, so the user's is re-asserted.
    if let Err(e) = dingo_enrich::name_unlocated_rides(&pool).await {
        tracing::warn!(error = %e, "plan locality naming failed (gazetteer empty?)");
    }
    sqlx::query("UPDATE rides SET name = $1, name_source = 'original' WHERE id = $2")
        .bind(name)
        .bind(ride_id.0)
        .execute(&pool)
        .await
        .map_err(|e| internal(e.to_string()))?;

    Ok(Json(serde_json::json!({ "id": ride_id.0, "name": name })))
}

/// One leaf of the location hierarchy: the distinct
/// State / Region / first-LGA / first-suburb combination (the same keys the
/// on-disk library tree uses) with its live-ride count. The client folds
/// these into a browsable tree; NULL levels read as "Unknown".
#[derive(Debug, Serialize)]
pub struct LocationLeaf {
    pub state: String,
    pub region: String,
    pub lga: String,
    pub suburb: String,
    pub count: i64,
    /// Bounding box of the tracks under this leaf — [minLon, minLat, maxLon,
    /// maxLat] — so clicking a folder can fly the map to its tracks without
    /// them being loaded yet
    pub bbox: [f64; 4],
}

async fn ride_locations(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<Vec<LocationLeaf>>, (axum::http::StatusCode, String)> {
    let rows = sqlx::query(
        r#"
        SELECT COALESCE(state, 'Unknown') AS state,
               COALESCE(region, 'Unknown') AS region,
               COALESCE(lgas[1], 'Unknown') AS lga,
               COALESCE(suburbs[1], 'Unknown') AS suburb,
               COUNT(*) AS count,
               ST_XMin(ST_Extent(cleaned_geometry)) AS min_lon,
               ST_YMin(ST_Extent(cleaned_geometry)) AS min_lat,
               ST_XMax(ST_Extent(cleaned_geometry)) AS max_lon,
               ST_YMax(ST_Extent(cleaned_geometry)) AS max_lat
        FROM rides
        WHERE cleaned_geometry IS NOT NULL AND superseded_by IS NULL
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3, 4
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(
        rows.into_iter()
            .map(|r| LocationLeaf {
                state: r.get("state"),
                region: r.get("region"),
                lga: r.get("lga"),
                suburb: r.get("suburb"),
                count: r.get("count"),
                bbox: [
                    r.get("min_lon"),
                    r.get("min_lat"),
                    r.get("max_lon"),
                    r.get("max_lat"),
                ],
            })
            .collect(),
    ))
}

/// Aggregate totals over the whole library — computed in SQL so the stats bar
/// doesn't fetch (and truncate at the 5000-row cap) every ride's full geometry
/// just to sum distance and find the date range.
#[derive(Debug, Serialize)]
pub struct RideStatsResponse {
    pub ride_count: i64,
    pub total_distance_m: Option<f64>,
    pub first_date: Option<chrono::DateTime<chrono::Utc>>,
    pub last_date: Option<chrono::DateTime<chrono::Utc>>,
}

async fn ride_stats(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<RideStatsResponse>, (axum::http::StatusCode, String)> {
    let row = sqlx::query(
        r#"
        SELECT
            count(*)::int8 as ride_count,
            SUM(ST_Length(cleaned_geometry::geography))::float8 as total_distance_m,
            MIN(started_at) as first_date,
            MAX(started_at) as last_date
        FROM rides
        WHERE cleaned_geometry IS NOT NULL AND superseded_by IS NULL
          AND kind = 'recorded'
        "#,
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RideStatsResponse {
        ride_count: row.get("ride_count"),
        total_distance_m: row.get("total_distance_m"),
        first_date: row.get("first_date"),
        last_date: row.get("last_date"),
    }))
}

/// List rides with optional filtering
async fn list_rides(
    Extension(pool): Extension<PgPool>,
    Query(params): Query<ListRidesParams>,
) -> Result<Json<Vec<RideSummary>>, (axum::http::StatusCode, String)> {
    // Clamp pagination into a sane range — a negative LIMIT/OFFSET reaches
    // Postgres as a syntax error (500 on bad client input) rather than a 400.
    let limit = params.limit.unwrap_or(5000).clamp(0, 10000);
    let offset = params.offset.unwrap_or(0).max(0);

    // `fields=ids` → lean id-only rows: skip the geometry serialization and the
    // per-row geography maths entirely (the lasso only needs ids).
    // `fields=meta` → all summary fields but no geometry.
    let lean = params.fields.as_deref() == Some("ids");
    let meta_only = params.fields.as_deref() == Some("meta");

    // Simplify + trim coordinate precision by zoom: at z10 a pixel is ~130 m,
    // so a 0.002° (~220 m) tolerance and 4 decimals (~11 m) are invisible but
    // shrink a 30k-ride viewport payload by an order of magnitude.
    // PreserveTopology: plain ST_Simplify NULLs tracks that collapse.
    let (geom_expr, precision) = match params.zoom {
        Some(z) if z <= 10 => ("ST_SimplifyPreserveTopology(r.cleaned_geometry, 0.002)", 4),
        Some(z) if z <= 14 => ("ST_SimplifyPreserveTopology(r.cleaned_geometry, 0.0001)", 5),
        _ => ("r.cleaned_geometry", 6),
    };

    // Restrict to explicit ids (validated UUIDs, so safe to interpolate). An
    // `ids` param that yields nothing valid means "no rides", not "all rides".
    let ids_clause = match params.ids.as_ref() {
        Some(raw) => {
            let valid: Vec<String> = raw
                .split(',')
                .filter_map(|s| Uuid::parse_str(s.trim()).ok())
                .map(|u| format!("'{u}'"))
                .collect();
            if valid.is_empty() {
                "AND FALSE".to_string()
            } else {
                format!("AND r.id = ANY(ARRAY[{}]::uuid[])", valid.join(", "))
            }
        }
        None => String::new(),
    };

    // Search: bound as a single text[] of `%term%` patterns ($3); every term
    // must match (bool_and), so multi-word queries AND together. NULL = no filter.
    let search_patterns: Option<Vec<String>> = params.q.as_ref().and_then(|q| {
        let pats: Vec<String> = q
            .split_whitespace()
            .map(|t| format!("%{t}%"))
            .collect();
        (!pats.is_empty()).then_some(pats)
    });
    let search_clause = if search_patterns.is_some() {
        // COALESCE per pattern verdict: a NULL column (state, region, …) makes
        // the OR-chain NULL instead of false, and bool_and SKIPS NULL inputs —
        // so without it a multi-word query silently degrades to OR ("Glenhaven
        // loop" matched every loop in the library, 2026-08-15).
        "AND ($3::text[] IS NULL OR (
            SELECT bool_and(COALESCE(
                r.name ILIKE pat OR r.state ILIKE pat OR r.region ILIKE pat
                OR r.source ILIKE pat
                OR o.name ILIKE pat
                OR r.original_name ILIKE pat
                OR f.original_name ILIKE pat
                OR array_to_string(r.lgas, ' ') ILIKE pat
                OR array_to_string(r.suburbs, ' ') ILIKE pat
            , false))
            FROM unnest($3::text[]) AS pat
        ))"
    } else {
        // Still reference $3 so the bind count is constant.
        "AND ($3::text[] IS NULL OR TRUE)"
    };

    // Parse bounds: minLon,minLat,maxLon,maxLat. Reject non-finite values —
    // "NaN"/"inf" parse as f64 and would interpolate into the SQL as bare
    // identifiers (a 500).
    let bounds_clause = if let Some(ref bounds_str) = params.bounds {
        let parts: Vec<f64> = bounds_str
            .split(',')
            .filter_map(|s| s.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .collect();
        if parts.len() == 4 {
            format!(
                "AND ST_Intersects(r.cleaned_geometry, ST_MakeEnvelope({}, {}, {}, {}, 4326))",
                parts[0], parts[1], parts[2], parts[3]
            )
        } else {
            // A malformed bounds filter must mean "no rides", not "all rides" —
            // otherwise a truncated URL silently selects the whole table.
            "AND FALSE".to_string()
        }
    } else {
        String::new()
    };

    // Parse lasso polygon: "lon,lat;lon,lat;..." — floats only, so safe to
    // interpolate (same style as the bounds clause above).
    let polygon_clause = if let Some(ref poly_str) = params.polygon {
        let pts: Vec<(f64, f64)> = poly_str
            .split(';')
            .filter_map(|pair| {
                let mut it = pair.split(',');
                let lon: f64 = it.next()?.trim().parse().ok()?;
                let lat: f64 = it.next()?.trim().parse().ok()?;
                // Reject NaN/inf, which would interpolate as bare SQL identifiers.
                (lon.is_finite() && lat.is_finite()).then_some((lon, lat))
            })
            .collect();
        if pts.len() >= 3 {
            let mut ring: Vec<String> = pts.iter().map(|(lon, lat)| format!("{lon} {lat}")).collect();
            // Close the ring
            ring.push(ring[0].clone());
            format!(
                "AND ST_Intersects(r.cleaned_geometry, ST_MakeValid(ST_SetSRID(ST_MakePolygon(ST_GeomFromText('LINESTRING({})')), 4326)))",
                ring.join(", ")
            )
        } else {
            // A malformed filter must mean "no rides", not "all rides" —
            // otherwise a truncated URL would silently select everything.
            "AND FALSE".to_string()
        }
    } else {
        String::new()
    };

    // Lean rows carry only id + the non-null fields the mapping requires; the
    // heavy geography maths and geometry serialization are skipped.
    let select_body = if lean {
        "r.id,
            NULL::text as name,
            NULL::timestamptz as started_at,
            NULL::float8 as distance_m,
            NULL::float8 as duration_s,
            NULL::float8 as moving_s,
            r.mode::text as mode,
            'own'::text as class,
            NULL::float8 as avg_hr, NULL::float8 as max_hr,
            NULL::float8 as avg_speed, NULL::float8 as max_speed,
            NULL::text as source,
            NULL::smallint as grade,
            NULL::uuid as owner_id, NULL::text as owner,
            NULL::text as state, NULL::text as region,
            NULL::text[] as lgas, NULL::text[] as suburbs,
            NULL::boolean as is_loop,
            r.kind::text as kind,
            NULL::text as collection, NULL::text as color,
            NULL::json as geometry"
            .to_string()
    } else {
        let geometry_col = if meta_only {
            "NULL::json as geometry".to_string()
        } else {
            format!("ST_AsGeoJSON({geom_expr}, {precision})::json as geometry")
        };
        format!(
            "r.id,
            r.name,
            r.started_at,
            ST_Length(r.cleaned_geometry::geography) as distance_m,
            EXTRACT(EPOCH FROM (r.ended_at - r.started_at))::float8 as duration_s,
            (EXTRACT(EPOCH FROM (r.ended_at - r.started_at))
             - COALESCE((SELECT SUM((s->>'duration_secs')::float8)
                         FROM jsonb_array_elements(r.stops) s), 0))::float8 as moving_s,
            r.mode::text as mode,
            CASE
                WHEN r.kind = 'planned' THEN 'plan'
                WHEN r.origin = 'other' THEN 'other'
                WHEN r.track_type = 'route'
                     OR r.started_at IS NULL THEN 'plan'
                ELSE 'own'
            END as class,
            r.avg_hr, r.max_hr,
            r.avg_speed_kmh as avg_speed, r.max_speed_kmh as max_speed,
            r.source, r.grade,
            r.owner_id, o.name as owner,
            r.state, r.region, r.lgas, r.suburbs,
            ST_Distance(ST_StartPoint(r.cleaned_geometry)::geography,
                        ST_EndPoint(r.cleaned_geometry)::geography)
                < GREATEST(500, ST_Length(r.cleaned_geometry::geography) * 0.02) as is_loop,
            r.kind::text as kind,
            r.collection, r.color,
            {geometry_col}"
        )
    };

    let query = format!(
        r#"
        SELECT {select_body}
        FROM rides r
        JOIN owners o ON o.id = r.owner_id
        JOIN files f ON f.id = r.file_id
        WHERE r.cleaned_geometry IS NOT NULL
          AND r.superseded_by IS NULL
        {bounds_clause}
        {polygon_clause}
        {ids_clause}
        {search_clause}
          AND ($4::text IS NULL OR COALESCE(r.state, 'Unknown') = $4)
          AND ($5::text IS NULL OR COALESCE(r.region, 'Unknown') = $5)
          AND ($6::text IS NULL OR COALESCE(r.lgas[1], 'Unknown') = $6)
          AND ($7::text IS NULL OR COALESCE(r.suburbs[1], 'Unknown') = $7)
        ORDER BY r.started_at DESC NULLS LAST
        LIMIT $1 OFFSET $2
        "#,
    );

    let rows = sqlx::query(&query)
        .bind(limit)
        .bind(offset)
        .bind(search_patterns.as_deref())
        .bind(params.state.as_deref())
        .bind(params.region.as_deref())
        .bind(params.lga.as_deref())
        .bind(params.suburb.as_deref())
        .fetch_all(&pool)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rides: Vec<RideSummary> = rows
        .into_iter()
        .map(|row| RideSummary {
            id: row.get("id"),
            name: row.get("name"),
            started_at: row.get("started_at"),
            distance_m: row.get("distance_m"),
            duration_s: row.get("duration_s"),
            moving_s: row.get("moving_s"),
            mode: row.get("mode"),
            class: row.get("class"),
            avg_hr: row.get("avg_hr"),
            max_hr: row.get("max_hr"),
            avg_speed: row.get("avg_speed"),
            max_speed: row.get("max_speed"),
            source: row.get("source"),
            grade: row.get("grade"),
            owner_id: row.get("owner_id"),
            owner: row.get("owner"),
            state: row.get("state"),
            region: row.get("region"),
            lgas: row.get("lgas"),
            suburbs: row.get("suburbs"),
            is_loop: row.get("is_loop"),
            kind: row.get("kind"),
            collection: row.get("collection"),
            color: row.get("color"),
            geometry: row.get("geometry"),
        })
        .collect();

    Ok(Json(rides))
}

/// Get single ride with full geometry
async fn get_ride(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> Result<Json<RideDetail>, (axum::http::StatusCode, String)> {
    let row = sqlx::query(
        r#"
        SELECT
            r.id,
            r.name,
            r.started_at,
            r.ended_at,
            ST_Length(r.cleaned_geometry::geography) as distance_m,
            EXTRACT(EPOCH FROM (r.ended_at - r.started_at))::float8 as duration_s,
            r.avg_speed_kmh as avg_speed, r.max_speed_kmh as max_speed,
            r.avg_hr, r.max_hr,
            r.inferred_condition::text as condition,
            -- time_of_day is a Postgres enum; cast to text or row.get panics on
            -- decode for any enriched ride, crashing GET /api/rides/{id}.
            r.time_of_day::text as time_of_day,
            r.mode::text as mode,
            r.source, r.grade,
            r.state, r.region, r.lgas, r.suburbs,
            r.kind::text as kind,
            r.collection, r.color, r.description, r.folder_id,
            COALESCE((SELECT array_agg(il.label_id) FROM item_labels il
                      WHERE il.item_type = 'ride' AND il.item_id = r.id),
                     '{}'::uuid[]) as label_ids,
            r.owner_id, o.name as owner_name, o.kind as owner_kind,
            r.original_name,
            f.original_name as file_name,
            f.source_path,
            r.imported_at,
            r.exported_path as library_path,
            ST_AsGeoJSON(r.cleaned_geometry)::json as geometry,
            r.cleaned_time_series as time_series
        FROM rides r
        JOIN owners o ON o.id = r.owner_id
        JOIN files f ON f.id = r.file_id
        WHERE r.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match row {
        Some(row) => {
            let time_series: Option<serde_json::Value> = row.get("time_series");
            let (elevation_gain, elevation_loss) =
                elevation_gain_loss(time_series.as_ref());
            Ok(Json(RideDetail {
                id: row.get("id"),
                name: row.get("name"),
                started_at: row.get("started_at"),
                ended_at: row.get("ended_at"),
                distance_m: row.get("distance_m"),
                duration_s: row.get("duration_s"),
                elevation_gain,
                elevation_loss,
                avg_speed: row.get("avg_speed"),
                max_speed: row.get("max_speed"),
                avg_hr: row.get("avg_hr"),
                max_hr: row.get("max_hr"),
                condition: row.get("condition"),
                time_of_day: row.get("time_of_day"),
                mode: row.get("mode"),
                source: row.get("source"),
                grade: row.get("grade"),
                owner: OwnerRef {
                    id: row.get("owner_id"),
                    name: row.get("owner_name"),
                    kind: row.get("owner_kind"),
                },
                original_name: row.get("original_name"),
                file_name: row.get("file_name"),
                imported_at: row.get("imported_at"),
                imported_from: imported_from_folder(
                    row.get::<Option<String>, _>("source_path").as_deref(),
                ),
                library_path: row.get("library_path"),
                state: row.get("state"),
                region: row.get("region"),
                lgas: row.get("lgas"),
                suburbs: row.get("suburbs"),
                kind: row.get("kind"),
                collection: row.get("collection"),
                color: row.get("color"),
                description: row.get("description"),
                folder_id: row.get("folder_id"),
                label_ids: row.get("label_ids"),
                geometry: row.get("geometry"),
                time_series,
            }))
        }
        None => Err((
            axum::http::StatusCode::NOT_FOUND,
            "Ride not found".to_string(),
        )),
    }
}

/// Cumulative elevation gain and loss (metres) from a cleaned time series,
/// using 1 m hysteresis so GPS elevation noise doesn't inflate the totals.
/// Returns `(None, None)` when the series is absent or lacks elevations.
fn elevation_gain_loss(time_series: Option<&serde_json::Value>) -> (Option<f64>, Option<f64>) {
    let arr = match time_series.and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => return (None, None),
    };
    let eles: Vec<f64> = arr
        .iter()
        .filter_map(|p| p.get("ele").and_then(|e| e.as_f64()))
        .collect();
    if eles.len() < 2 {
        return (None, None);
    }

    const HYSTERESIS_M: f64 = 1.0;
    let (mut gain, mut loss) = (0.0, 0.0);
    let mut reference = eles[0];
    for &e in &eles[1..] {
        let delta = e - reference;
        if delta > HYSTERESIS_M {
            gain += delta;
            reference = e;
        } else if delta < -HYSTERESIS_M {
            loss += -delta;
            reference = e;
        }
    }
    (Some(gain), Some(loss))
}

/// Request body for updating ride mode
#[derive(Debug, Deserialize)]
pub struct UpdateRideModeRequest {
    #[serde(default)]
    pub mode: Option<String>,
    /// Difficulty 1-5 (Grant's scale); use clear_grade to unset
    #[serde(default)]
    pub grade: Option<i16>,
    #[serde(default)]
    pub clear_grade: bool,
    /// Reassign the track to another owner (owners.id)
    #[serde(default)]
    pub owner_id: Option<Uuid>,
}

/// Update ride mode
async fn update_ride_mode(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateRideModeRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let internal =
        |e: sqlx::Error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string());

    if body.mode.is_none() && body.grade.is_none() && !body.clear_grade && body.owner_id.is_none() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "nothing to update — send mode, grade, and/or owner_id".to_string(),
        ));
    }

    // Validate EVERYTHING before writing anything — a valid mode + invalid
    // grade used to commit the mode (and mode_source='user', blocking future
    // reclassification) then 400 on the grade, hiding a persisted write
    // behind an error response (audit M3).
    if let Some(mode) = &body.mode {
        let valid_modes = ["adv", "enduro", "mtb", "watersport", "other"];
        if !valid_modes.contains(&mode.as_str()) {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                format!("Invalid mode. Must be one of: {valid_modes:?}"),
            ));
        }
    }
    if let Some(g) = body.grade {
        if !(1..=5).contains(&g) {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "grade must be 1-5".to_string(),
            ));
        }
    }
    if let Some(owner_id) = body.owner_id {
        let owner_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM owners WHERE id = $1)")
                .bind(owner_id)
                .fetch_one(&pool)
                .await
                .map_err(internal)?;
        if !owner_exists {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "unknown owner_id".to_string(),
            ));
        }
    }

    // Both writes in one transaction so mode + grade succeed or fail together.
    let mut tx = pool.begin().await.map_err(internal)?;
    if let Some(mode) = &body.mode {
        // mode is validated against a fixed allowlist above, safe to interpolate.
        sqlx::query(&format!(
            "UPDATE rides SET mode = '{mode}', mode_source = 'user' WHERE id = $1",
        ))
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    if body.grade.is_some() || body.clear_grade {
        sqlx::query("UPDATE rides SET grade = $1 WHERE id = $2")
            .bind(if body.clear_grade { None } else { body.grade })
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    if let Some(owner_id) = body.owner_id {
        sqlx::query("UPDATE rides SET owner_id = $1 WHERE id = $2")
            .bind(owner_id)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    // One existence check (any UPDATE above matched the same row or none).
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rides WHERE id = $1)")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if !exists {
        return Err((axum::http::StatusCode::NOT_FOUND, "Ride not found".to_string()));
    }
    tx.commit().await.map_err(internal)?;

    Ok(Json(
        serde_json::json!({ "success": true, "mode": body.mode, "grade": body.grade }),
    ))
}

/// Point data for a ride
#[derive(Debug, Serialize)]
pub struct RidePoint {
    pub idx: i32,
    pub lon: f64,
    pub lat: f64,
    pub elevation: Option<f64>,
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
    pub heart_rate: Option<i32>,
    pub speed: Option<f64>,
    /// Cumulative distance along the ride in metres (from the time series) —
    /// with elevation this gives per-section grade without recomputing
    /// haversine distances client-side.
    pub distance_m: Option<f64>,
}

/// Get ride points with time series data
async fn get_ride_points(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<RidePoint>>, (axum::http::StatusCode, String)> {
    // Get geometry points
    let rows = sqlx::query(
        r#"
        WITH points AS (
            SELECT
                (dp).path[1] as idx,
                ST_X((dp).geom) as lon,
                ST_Y((dp).geom) as lat,
                ST_Z((dp).geom) as elevation
            FROM (
                SELECT ST_DumpPoints(cleaned_geometry) as dp
                FROM rides WHERE id = $1
            ) sub
        )
        SELECT idx, lon, lat, elevation FROM points ORDER BY idx
        "#,
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Get time series
    let ts_row = sqlx::query("SELECT cleaned_time_series FROM rides WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let time_series: Vec<serde_json::Value> = ts_row
        .and_then(|r| r.get::<Option<serde_json::Value>, _>("cleaned_time_series"))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();

    let points: Vec<RidePoint> = rows
        .into_iter()
        .map(|row| {
            let idx: i32 = row.get("idx");
            let ts_item = time_series.get((idx - 1) as usize);

            RidePoint {
                idx,
                lon: row.get("lon"),
                lat: row.get("lat"),
                // cleaned_geometry is stored 2D (ST_Force2D on clean), so the
                // geometry Z is always NULL — elevation lives in the time
                // series as 'ele'.
                elevation: row
                    .get::<Option<f64>, _>("elevation")
                    .or_else(|| ts_item.and_then(|v| v.get("ele")).and_then(|v| v.as_f64())),
                timestamp: ts_item
                    .and_then(|v| v.get("time"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&chrono::Utc)),
                heart_rate: ts_item
                    .and_then(|v| v.get("heart_rate"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                speed: ts_item
                    .and_then(|v| v.get("speed_ms"))
                    .and_then(|v| v.as_f64()),
                distance_m: ts_item
                    .and_then(|v| v.get("distance_cumulative_m"))
                    .and_then(|v| v.as_f64()),
            }
        })
        .collect();

    Ok(Json(points))
}
