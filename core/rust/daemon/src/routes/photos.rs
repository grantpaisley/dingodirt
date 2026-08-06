//! Photos API endpoints
//!
//! Thumbnails/mediums are served as static files under /photos (see lib.rs);
//! the URLs returned here are paths on this server. Full-resolution originals
//! live in Google Photos via google_photos_url.

use axum::{Json, Router, extract::Extension, routing::get};
use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct PhotoSummary {
    pub id: Uuid,
    pub lon: f64,
    pub lat: f64,
    pub taken_at: Option<chrono::DateTime<chrono::Utc>>,
    pub thumb_url: String,
    pub medium_url: String,
    pub google_photos_url: Option<String>,
    pub ride_id: Option<Uuid>,
    pub match_method: Option<String>,
}

pub fn routes() -> Router {
    Router::new().route("/", get(list_photos))
}

/// List all photos that have a position (matched or GPS-tagged)
async fn list_photos(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<Vec<PhotoSummary>>, (axum::http::StatusCode, String)> {
    let rows = sqlx::query(
        r#"
        SELECT
            id, sha256,
            ST_X(location) as lon,
            ST_Y(location) as lat,
            taken_at,
            google_photos_url,
            ride_id,
            match_method::TEXT as match_method
        FROM photos
        WHERE location IS NOT NULL
        ORDER BY taken_at
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let photos: Vec<PhotoSummary> = rows
        .into_iter()
        .map(|row| {
            let sha256: String = row.get("sha256");
            PhotoSummary {
                id: row.get("id"),
                lon: row.get("lon"),
                lat: row.get("lat"),
                taken_at: row.get("taken_at"),
                thumb_url: format!("/photos/{sha256}_thumb.jpg"),
                medium_url: format!("/photos/{sha256}_medium.jpg"),
                google_photos_url: row.get("google_photos_url"),
                ride_id: row.get("ride_id"),
                match_method: row.get("match_method"),
            }
        })
        .collect();

    Ok(Json(photos))
}
