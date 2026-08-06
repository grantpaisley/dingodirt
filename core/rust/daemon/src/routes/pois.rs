//! POI API — points of interest from planned-route collections
//!
//! POIs are a standalone layer (fuel matters wherever you are, not just on
//! the route that shipped it): viewport-windowed like tracks, filterable by
//! category and collection.

use axum::{
    Json, Router,
    extract::{Extension, Query},
    routing::get,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct PoiParams {
    /// Bounding box: minLon,minLat,maxLon,maxLat (omit for all)
    pub bounds: Option<String>,
    /// Comma-separated category filter (fuel,camp,water,…)
    pub categories: Option<String>,
    /// Comma-separated collection filter
    pub collections: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Poi {
    pub id: Uuid,
    pub lon: f64,
    pub lat: f64,
    pub elevation: Option<f32>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
}

/// One planned-route collection, for the layers pane
#[derive(Debug, Serialize)]
pub struct Collection {
    pub name: String,
    pub route_count: i64,
    pub poi_count: i64,
    pub total_km: f64,
    /// [minLon, minLat, maxLon, maxLat] over the collection's routes
    pub bbox: Option<[f64; 4]>,
}

pub fn routes() -> Router {
    Router::new().route("/", get(list_pois))
}

pub fn collection_routes() -> Router {
    Router::new().route("/", get(list_collections))
}

async fn list_pois(
    Extension(pool): Extension<PgPool>,
    Query(params): Query<PoiParams>,
) -> Result<Json<Vec<Poi>>, (axum::http::StatusCode, String)> {
    // Bounds: floats only — safe to interpolate (same style as /api/rides).
    // Malformed bounds mean "no POIs", not "all POIs".
    let bounds_clause = if let Some(ref bounds_str) = params.bounds {
        let parts: Vec<f64> = bounds_str
            .split(',')
            .filter_map(|s| s.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .collect();
        if parts.len() == 4 {
            format!(
                "AND ST_Intersects(p.position, ST_MakeEnvelope({}, {}, {}, {}, 4326))",
                parts[0], parts[1], parts[2], parts[3]
            )
        } else {
            "AND FALSE".to_string()
        }
    } else {
        String::new()
    };

    let categories: Option<Vec<String>> = params.categories.as_ref().map(|c| {
        c.split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    });
    let collections: Option<Vec<String>> = params.collections.as_ref().map(|c| {
        c.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    let query = format!(
        r#"
        SELECT
            p.id,
            ST_X(p.position) as lon,
            ST_Y(p.position) as lat,
            p.elevation,
            p.name,
            p.description,
            p.category::text as category,
            p.collection
        FROM pois p
        WHERE ($1::text[] IS NULL OR p.category::text = ANY($1))
          AND ($2::text[] IS NULL OR p.collection = ANY($2))
        {bounds_clause}
        ORDER BY p.name
        "#,
    );

    let rows = sqlx::query(&query)
        .bind(categories.as_deref())
        .bind(collections.as_deref())
        .fetch_all(&pool)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let pois: Vec<Poi> = rows
        .into_iter()
        .map(|row| Poi {
            id: row.get("id"),
            lon: row.get("lon"),
            lat: row.get("lat"),
            elevation: row.get("elevation"),
            name: row.get("name"),
            description: row.get("description"),
            category: row.get("category"),
            collection: row.get("collection"),
        })
        .collect();

    Ok(Json(pois))
}

async fn list_collections(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<Vec<Collection>>, (axum::http::StatusCode, String)> {
    let rows = sqlx::query(
        r#"
        WITH route_agg AS (
            SELECT collection,
                   count(*) AS route_count,
                   SUM(ST_Length(cleaned_geometry::geography)) / 1000.0 AS total_km,
                   ST_Extent(cleaned_geometry) AS extent
            FROM rides
            WHERE kind = 'planned' AND collection IS NOT NULL
            GROUP BY collection
        ),
        poi_agg AS (
            SELECT collection, count(*) AS poi_count
            FROM pois
            WHERE collection IS NOT NULL
            GROUP BY collection
        )
        SELECT
            COALESCE(r.collection, p.collection) AS name,
            COALESCE(r.route_count, 0) AS route_count,
            COALESCE(p.poi_count, 0) AS poi_count,
            COALESCE(r.total_km, 0) AS total_km,
            ST_XMin(r.extent) AS min_lon, ST_YMin(r.extent) AS min_lat,
            ST_XMax(r.extent) AS max_lon, ST_YMax(r.extent) AS max_lat
        FROM route_agg r
        FULL OUTER JOIN poi_agg p ON p.collection = r.collection
        ORDER BY 1
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let collections: Vec<Collection> = rows
        .into_iter()
        .map(|row| {
            let bbox = match (
                row.get::<Option<f64>, _>("min_lon"),
                row.get::<Option<f64>, _>("min_lat"),
                row.get::<Option<f64>, _>("max_lon"),
                row.get::<Option<f64>, _>("max_lat"),
            ) {
                (Some(a), Some(b), Some(c), Some(d)) => Some([a, b, c, d]),
                _ => None,
            };
            Collection {
                name: row.get("name"),
                route_count: row.get("route_count"),
                poi_count: row.get("poi_count"),
                total_km: row.get::<Option<f64>, _>("total_km").unwrap_or(0.0),
                bbox,
            }
        })
        .collect();

    Ok(Json(collections))
}
