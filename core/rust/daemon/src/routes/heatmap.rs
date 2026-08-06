//! Heatmap API — lightweight classed track geometries for density rendering.
//!
//! Returns only {id, class, mode, geometry} per ride: no per-ride stats
//! subqueries (the expensive part of /api/rides), so the whole dataset can be
//! fetched in one request and additively blended on the GPU.

use axum::{
    Json, Router,
    extract::{Extension, Query},
    routing::get,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Query parameters for the heatmap
#[derive(Debug, Deserialize)]
pub struct HeatmapParams {
    /// Zoom level for geometry resolution (<=10 coarse, <=14 medium, else full)
    pub zoom: Option<u8>,
    /// Bounding box: minLon,minLat,maxLon,maxLat
    pub bounds: Option<String>,
}

/// One classed track. class: 'own' | 'other' | 'plan'
/// started_at, has_hr and has_speed let the client apply the SAME visibility
/// filters (date range, has-HR, has-speed) as the rides layer and list — has_hr
/// and has_speed are derived from the persisted avg_hr / avg_speed_kmh columns
/// (non-null), exactly as rideMatchesFilters does, so the two never disagree
/// about which tracks exist.
#[derive(Debug, Serialize)]
pub struct HeatmapTrack {
    pub id: Uuid,
    pub class: String,
    pub mode: String,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub has_hr: bool,
    pub has_speed: bool,
    /// Planned routes only: collection label and stored display color, so
    /// the planned layers can render/filter from this one cheap payload
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub geometry: Option<serde_json::Value>,
}

/// Build heatmap routes
pub fn routes() -> Router {
    Router::new().route("/", get(get_heatmap))
}

/// Classed simplified geometries for every ride intersecting the bounds.
///
/// Class rules (tag wins over sensor data):
///   other = origin 'other'
///   plan  = own tracks that are routes or lack timestamps — anything with
///           speed or duration data is a recording, never a plan
///   own   = the user's recorded rides (timestamped)
async fn get_heatmap(
    Extension(pool): Extension<PgPool>,
    Query(params): Query<HeatmapParams>,
) -> Result<Json<Vec<HeatmapTrack>>, (axum::http::StatusCode, String)> {
    // Simplify on the fly + trim coordinate precision by zoom (cheap in
    // PostGIS, shrinks a 30k-track payload by an order of magnitude: at z10
    // a pixel is ~130 m, so 0.002°/4-decimal coords are invisible).
    // PreserveTopology: plain ST_Simplify returns NULL for tracks that
    // collapse below 2 points at the tolerance.
    let (geom_expr, precision) = match params.zoom {
        Some(z) if z <= 10 => ("ST_SimplifyPreserveTopology(r.cleaned_geometry, 0.002)", 4),
        Some(z) if z <= 14 => ("ST_SimplifyPreserveTopology(r.cleaned_geometry, 0.0001)", 5),
        _ => ("r.cleaned_geometry", 6),
    };

    // Parse bounds: minLon,minLat,maxLon,maxLat (floats only — safe to
    // interpolate, same style as /api/rides)
    let bounds_clause = if let Some(ref bounds_str) = params.bounds {
        let parts: Vec<f64> = bounds_str
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        if parts.len() == 4 {
            format!(
                "AND ST_Intersects(r.cleaned_geometry, ST_MakeEnvelope({}, {}, {}, {}, 4326))",
                parts[0], parts[1], parts[2], parts[3]
            )
        } else {
            // Malformed filter means "no tracks", not "all tracks"
            "AND FALSE".to_string()
        }
    } else {
        String::new()
    };

    let query = format!(
        r#"
        SELECT
            r.id,
            CASE
                WHEN r.kind = 'planned' THEN 'plan'
                WHEN r.origin = 'other' THEN 'other'
                WHEN r.track_type = 'route'
                     OR r.started_at IS NULL THEN 'plan'
                ELSE 'own'
            END as class,
            r.mode::text as mode,
            r.started_at,
            -- Same signal the rides list/layer filter on, so visibility agrees.
            (r.avg_hr IS NOT NULL) as has_hr,
            (r.avg_speed_kmh IS NOT NULL) as has_speed,
            r.collection,
            r.color,
            ST_AsGeoJSON({geom_expr}, {precision})::json as geometry
        FROM rides r
        WHERE r.cleaned_geometry IS NOT NULL
          AND r.superseded_by IS NULL
        {bounds_clause}
        "#,
    );

    let rows = sqlx::query(&query)
        .fetch_all(&pool)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let tracks: Vec<HeatmapTrack> = rows
        .into_iter()
        .map(|row| HeatmapTrack {
            id: row.get("id"),
            class: row.get("class"),
            mode: row.get("mode"),
            started_at: row.get("started_at"),
            has_hr: row.get("has_hr"),
            has_speed: row.get("has_speed"),
            collection: row.get("collection"),
            color: row.get("color"),
            geometry: row.get("geometry"),
        })
        .collect();

    Ok(Json(tracks))
}
