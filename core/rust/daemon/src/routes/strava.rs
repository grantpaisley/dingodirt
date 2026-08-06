//! Strava global heatmap tile proxy.
//!
//! Strava serves the heatmap as pre-rendered PNG raster tiles from
//! `content-a.strava.com/identified/globalheat/...` (moved off the old
//! `heatmap-external-*` hosts), gated by the three CloudFront signed cookies
//! (Key-Pair-Id / Policy / Signature, ~24 h expiry) PLUS the `_strava_idcf`
//! identity JWT — the session cookie itself is not required. Our MapLibre map
//! is a different origin, so the browser won't send those cookies cross-origin
//! — this daemon holds them and proxies the tiles.
//!
//! Cookie acquisition is plan B: headless login is dead (React SPA + reCAPTCHA
//! as of 2026-07), so the user pastes the values from a logged-in browser
//! (copy-as-curl of any heat-tile request works) into the web UI, which POSTs
//! them here. See Docs/plans/2026-07-11-strava-overlay-bundle-v2-design.md.

use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, Path},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tracing::warn;

/// Disk tile cache TTL — tiles change slowly and cookies expire weekly anyway,
/// so a fortnight keeps panning cheap without serving stale heatmaps forever.
const TILE_TTL: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// Shared HTTP client (connection pool reused across tile fetches).
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Dingo/heatmap-proxy")
            .timeout(Duration::from_secs(20))
            .build()
            .expect("build reqwest client")
    })
}

pub fn routes() -> Router {
    Router::new()
        .route("/status", get(get_status))
        .route("/cookies", post(set_cookies))
        .route("/tiles/{z}/{x}/{y}", get(get_tile))
}

// ---------------------------------------------------------------------------
// Cookie storage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Cookies {
    key_pair_id: String,
    policy: String,
    signature: String,
    /// `_strava_idcf` identity JWT — required by the `identified/` endpoint.
    /// None for rows pasted before the column existed (auth then fails with
    /// the standard "reconnect" message).
    idcf: Option<String>,
}

impl Cookies {
    /// The `Cookie:` header value CloudFront expects.
    fn header(&self) -> String {
        let mut h = format!(
            "CloudFront-Key-Pair-Id={}; CloudFront-Policy={}; CloudFront-Signature={}",
            self.key_pair_id, self.policy, self.signature
        );
        if let Some(idcf) = &self.idcf {
            h.push_str("; _strava_idcf=");
            h.push_str(idcf);
        }
        h
    }
}

async fn load_cookies(pool: &PgPool) -> Result<Option<Cookies>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT key_pair_id, policy, signature, idcf FROM strava_heatmap_cookies WHERE id = TRUE",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| Cookies {
        key_pair_id: r.get("key_pair_id"),
        policy: r.get("policy"),
        signature: r.get("signature"),
        idcf: r.get("idcf"),
    }))
}

// ---------------------------------------------------------------------------
// POST /cookies — save pasted values
// ---------------------------------------------------------------------------

/// Accepts either the three values separately, or a single raw `cookie` string
/// pasted straight from devtools (we pull the CloudFront-* names out of it).
#[derive(Debug, Deserialize)]
pub struct SetCookiesBody {
    #[serde(default)]
    key_pair_id: Option<String>,
    #[serde(default)]
    policy: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    /// `_strava_idcf` identity JWT (needed by the identified/ endpoint).
    #[serde(default)]
    idcf: Option<String>,
    /// Raw `document.cookie` / request Cookie header paste — parsed if the
    /// explicit fields aren't all present.
    #[serde(default)]
    cookie: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StatusBody {
    connected: bool,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

async fn set_cookies(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<SetCookiesBody>,
) -> Result<Json<StatusBody>, (StatusCode, String)> {
    let cookies = resolve_cookies(&body)
        .ok_or((StatusCode::BAD_REQUEST,
            "need CloudFront-Key-Pair-Id, -Policy and -Signature (as three fields or one pasted cookie string)".to_string()))?;

    sqlx::query(
        r#"
        INSERT INTO strava_heatmap_cookies (id, key_pair_id, policy, signature, idcf, updated_at)
        VALUES (TRUE, $1, $2, $3, $4, now())
        ON CONFLICT (id) DO UPDATE
          SET key_pair_id = EXCLUDED.key_pair_id,
              policy      = EXCLUDED.policy,
              signature   = EXCLUDED.signature,
              idcf        = EXCLUDED.idcf,
              updated_at  = now()
        "#,
    )
    .bind(&cookies.key_pair_id)
    .bind(&cookies.policy)
    .bind(&cookies.signature)
    .bind(&cookies.idcf)
    .execute(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(StatusBody { connected: true, updated_at: None }))
}

/// Pull the CloudFront values (+ `_strava_idcf`) from explicit fields, falling
/// back to parsing a raw pasted cookie string (`name=value; name=value; …`).
fn resolve_cookies(body: &SetCookiesBody) -> Option<Cookies> {
    let clean = |s: &Option<String>| s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let (Some(k), Some(p), Some(s)) =
        (clean(&body.key_pair_id), clean(&body.policy), clean(&body.signature))
    {
        return Some(Cookies { key_pair_id: k, policy: p, signature: s, idcf: clean(&body.idcf) });
    }
    let raw = body.cookie.as_ref()?;
    let mut key_pair_id = None;
    let mut policy = None;
    let mut signature = None;
    let mut idcf = None;
    for part in raw.split(';') {
        // Tolerate stray no-'=' fragments in a messy paste instead of bailing.
        let Some((name, value)) = part.split_once('=') else { continue };
        match name.trim() {
            "CloudFront-Key-Pair-Id" => key_pair_id = Some(value.trim().to_string()),
            "CloudFront-Policy" => policy = Some(value.trim().to_string()),
            "CloudFront-Signature" => signature = Some(value.trim().to_string()),
            "_strava_idcf" => idcf = Some(value.trim().to_string()),
            _ => {}
        }
    }
    Some(Cookies {
        key_pair_id: key_pair_id?,
        policy: policy?,
        signature: signature?,
        idcf,
    })
}

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------

async fn get_status(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<StatusBody>, (StatusCode, String)> {
    let row = sqlx::query("SELECT updated_at FROM strava_heatmap_cookies WHERE id = TRUE")
        .fetch_optional(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(StatusBody {
        connected: row.is_some(),
        updated_at: row.map(|r| r.get("updated_at")),
    }))
}

// ---------------------------------------------------------------------------
// GET /tiles/{z}/{x}/{y} — proxy + disk cache
// ---------------------------------------------------------------------------

/// Why a tile fetch failed — lets the live route and the bundle exporter react
/// differently (the route returns an HTTP status; the exporter counts and skips).
pub(crate) enum TileError {
    NotConnected,
    Rejected,      // 401/403 — cookies bad/expired/mismatched
    Upstream(u16), // other non-200 (503 origin down, 404 empty tile, …)
    Fetch(String),
    Internal(String),
}

/// Fetch one Strava heatmap tile, serving from the disk cache when fresh.
/// Shared by the live proxy route and the export bundler.
pub(crate) async fn fetch_tile(pool: &PgPool, z: u32, x: u32, y: u32) -> Result<Vec<u8>, TileError> {
    // Disk cache first — the hot path for panning, repeat views, and bundle
    // corridors that overlap tiles already viewed in the web UI.
    let cache_path = tile_cache_path(z, x, y);
    if let Some(bytes) = read_fresh(&cache_path) {
        return Ok(bytes);
    }

    let cookies = load_cookies(pool)
        .await
        .map_err(|e| TileError::Internal(e.to_string()))?
        .ok_or(TileError::NotConnected)?;

    // Strava's current heat endpoint (the old heatmap-external-* hosts are
    // dead): 512px tiles, `hot` colour scheme, `missing=empty` → 404 for
    // no-data tiles like before.
    let url = format!(
        "https://content-a.strava.com/identified/globalheat/all/hot/{z}/{x}/{y}.png?v=20&missing=empty"
    );
    let resp = http()
        .get(&url)
        .header(header::COOKIE, cookies.header())
        .header(header::REFERER, "https://www.strava.com/")
        .send()
        .await
        .map_err(|e| TileError::Fetch(e.to_string()))?;

    match resp.status().as_u16() {
        200 => {}
        upstream @ (401 | 403) => {
            // CloudFront explains itself in a short XML body (e.g. "InvalidKey /
            // Unknown Key" for a mismatched Key-Pair-Id). Surface it so a bad
            // cookie grab is diagnosable at a glance.
            let body = resp.text().await.unwrap_or_default();
            warn!(z, x, y, status = upstream, body = %body.trim(),
                "Strava rejected heatmap tile auth");
            return Err(TileError::Rejected);
        }
        other => {
            // 503 = signature OK but origin unavailable (transient / rate-limit);
            // 404 = empty tile. Log so we can tell them apart.
            warn!(z, x, y, status = other, "Strava heatmap tile upstream non-200");
            return Err(TileError::Upstream(other));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| TileError::Fetch(e.to_string()))?
        .to_vec();

    // Best-effort disk cache; a write failure just means we refetch next time.
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(&cache_path, &bytes);
    }

    Ok(bytes)
}

async fn get_tile(
    Extension(pool): Extension<PgPool>,
    Path((z, x, y_raw)): Path<(u32, u32, String)>,
) -> Response {
    // MapLibre requests `.../{z}/{x}/{y}.png`; strip the extension off the last
    // segment. Reject anything that isn't a plain integer tile coordinate.
    let y_str = y_raw.strip_suffix(".png").unwrap_or(&y_raw);
    let y: u32 = match y_str.parse() {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad tile y").into_response(),
    };
    if z > 20 {
        return (StatusCode::BAD_REQUEST, "zoom out of range").into_response();
    }

    match fetch_tile(&pool, z, x, y).await {
        Ok(bytes) => png(bytes),
        Err(TileError::NotConnected) => {
            (StatusCode::CONFLICT, "Strava not connected — paste cookies first").into_response()
        }
        Err(TileError::Rejected) => (
            StatusCode::CONFLICT,
            "Strava rejected the cookies (expired or mismatched) — reconnect",
        )
            .into_response(),
        Err(TileError::Upstream(s)) => {
            (StatusCode::BAD_GATEWAY, format!("strava returned {s}")).into_response()
        }
        Err(TileError::Fetch(e)) => {
            (StatusCode::BAD_GATEWAY, format!("strava fetch failed: {e}")).into_response()
        }
        Err(TileError::Internal(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn tile_cache_path(z: u32, x: u32, y: u32) -> PathBuf {
    let base = dingo_core::Config::load()
        .map(|c| c.file_store_path)
        .unwrap_or_else(|_| PathBuf::from("./files"));
    base.join("strava-tiles").join("all-hot").join(z.to_string()).join(x.to_string()).join(format!("{y}.png"))
}

/// Read a cached tile if it exists and is younger than the TTL.
fn read_fresh(path: &PathBuf) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    let age = SystemTime::now().duration_since(meta.modified().ok()?).ok()?;
    if age > TILE_TTL {
        return None;
    }
    std::fs::read(path).ok()
}

fn png(bytes: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        Body::from(bytes),
    )
        .into_response()
}
