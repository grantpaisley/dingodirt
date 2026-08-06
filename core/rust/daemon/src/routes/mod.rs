//! API route handlers

pub mod areas;
pub mod dingodirt;
pub mod export;
pub mod heat;
pub mod heatmap;
pub mod import;
pub mod marks;
pub mod owners;
pub mod packs;
pub mod photos;
pub mod pois;
pub mod rides;
pub mod strava;
pub mod styles;

use axum::Router;

/// Build the API router with all routes
pub fn api_routes() -> Router {
    Router::new()
        .nest("/rides", rides::routes())
        .nest("/heatmap", heatmap::routes())
        .nest("/photos", photos::routes())
        .nest("/export", export::routes())
        .nest("/packs", packs::routes())
        .nest("/strava-heatmap", strava::routes())
        .nest("/heat", heat::routes())
        .nest("/areas", areas::routes())
        .nest("/owners", owners::routes())
        .nest("/import", import::routes())
        .nest("/pois", pois::routes())
        .nest("/collections", pois::collection_routes())
        .nest("/styles", styles::routes())
        .nest("/settings/dingodirt", dingodirt::routes())
}
