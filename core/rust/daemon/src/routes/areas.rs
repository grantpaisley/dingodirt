//! Areas API — boundary polygons for the map's areas overlay.

use axum::{Json, Router, extract::Extension, routing::get};
use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct AreaSummary {
    pub id: Uuid,
    pub name: String,
    /// GeoJSON polygon/multipolygon boundary
    pub boundary: serde_json::Value,
}

pub fn routes() -> Router {
    Router::new().route("/", get(list_areas))
}

async fn list_areas(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<Vec<AreaSummary>>, (axum::http::StatusCode, String)> {
    let rows = sqlx::query(
        "SELECT id, name, ST_AsGeoJSON(boundary, 5)::json AS boundary
         FROM areas WHERE boundary IS NOT NULL ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(
        rows.into_iter()
            .map(|r| AreaSummary {
                id: r.get("id"),
                name: r.get("name"),
                boundary: r.get("boundary"),
            })
            .collect(),
    ))
}
