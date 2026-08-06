//! Dingo Daemon - API server for web UI

pub mod routes;

use axum::extract::Request;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::{Extension, Router};
use sqlx::PgPool;
use std::net::SocketAddr;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tracing::info;

/// Reject state-changing cross-site requests. The daemon has no user auth and
/// serves a local-first single user, so a malicious page the user visits
/// could otherwise drive `fetch()` at localhost:3000 and (e.g.) publish their
/// tracks via /api/export/share. Two gates together stop it:
///   1. CORS restricts read access to the known web origins (below), so a
///      hostile page can't read any response (ride list, share URL, ...).
///   2. Every non-GET request must carry `x-dingo-web: 1`. A cross-origin
///      fetch adding a custom header triggers a CORS preflight, which only
///      succeeds for an allowed origin — so the real mutation never fires
///      from a disallowed page. The web client sets this header; the CLI
///      talks to Postgres directly, not this API.
async fn require_web_header(req: Request, next: Next) -> Result<Response, StatusCode> {
    let safe = matches!(req.method(), &Method::GET | &Method::HEAD | &Method::OPTIONS);
    if safe || req.headers().get("x-dingo-web").is_some() {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

/// Start the API server
pub async fn serve(pool: PgPool, addr: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
    // Allowed browser origins: the Vite dev servers, plus an optional hosted
    // origin (DINGO_WEB_ORIGIN, e.g. https://plan.dingodirt.com).
    let mut origins: Vec<HeaderValue> = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5175",
        "http://127.0.0.1:5175",
        // Dingo Studio (serve.js default + .claude/launch.json port) — the
        // style-layers editor lives there now and saves via /api/styles.
        "http://localhost:8138",
        "http://127.0.0.1:8138",
        "http://localhost:8151",
        "http://127.0.0.1:8151",
    ]
    .iter()
    .filter_map(|o| o.parse().ok())
    .collect();
    if let Ok(extra) = std::env::var("DINGO_WEB_ORIGIN") {
        for o in extra.split(',') {
            if let Ok(v) = o.trim().parse() {
                origins.push(v);
            }
        }
    }

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        // x-dingo-web is the CSRF gate; content-type for JSON bodies.
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("x-dingo-web"),
        ])
        // Let the web UI read our custom manifest header on export responses.
        .expose_headers([axum::http::HeaderName::from_static("x-dingo-manifest")]);

    // Photo thumbnails/mediums (content-addressed store on disk)
    let photo_store = dingo_core::Config::load()
        .map(|c| c.photo_store_path)
        .unwrap_or_else(|_| std::path::PathBuf::from("./photos"));

    let app = Router::new()
        .nest("/api", routes::api_routes())
        .nest_service("/photos", ServeDir::new(photo_store))
        .layer(middleware::from_fn(require_web_header))
        // GeoJSON gzips ~4-5x — a 20 MB zoomed-out payload ships as ~4 MB
        .layer(CompressionLayer::new())
        .layer(cors)
        .layer(Extension(pool));

    info!("Starting Dingo API server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
