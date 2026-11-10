//! Garmin Connect Personal API: pull your own activities into Dingo.
//!
//! The user makes a personal API key on Garmin Connect
//! (connect.garmin.com/app/settings/personalApiToken) and pastes it once into
//! Plan's Settings. The key lives in app_settings, like the dingodirt.com
//! token. Each refresh swaps the key for a 24-hour access token, lists the
//! activities newer than the newest own ride, downloads each original file
//! (a zip that holds the FIT), and sends it through the normal ingest and
//! post-import pipeline. See
//! docs/plans/2026-11-10-garmin-personal-api-sync-design.md.

use axum::http::StatusCode;
use axum::{
    Json, Router,
    extract::Extension,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use super::dingodirt::{get_setting, set_setting};
use super::export::{ApiError, bad_request, internal};

const KEY_SETTING: &str = "garmin_api_key";
const TOKEN_PATH: &str = "/personalapitoken-service/personal-api/personal-api-key/token";
const LIST_PATH: &str = "/activitylist-service/activities/search/activities";
const PAGE: usize = 100;
/// Activities per refresh; the rest wait for the next click.
const BATCH: usize = 50;

pub fn routes() -> Router {
    Router::new()
        .route("/", get(status).put(set_key))
        .route("/sync", post(sync))
}

/// API base; `GARMIN_API_URL` points tests and the browser check at a mock.
fn api_base() -> String {
    std::env::var("GARMIN_API_URL")
        .unwrap_or_else(|_| "https://personal.connectapi.garmin.com".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Dingo/garmin-sync")
            // Garmin accepts TLS 1.3 only; macOS native TLS stops at 1.2.
            .use_rustls_tls()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("reqwest client")
    })
}

#[derive(Debug, PartialEq)]
enum GarminError {
    RateLimited,
    Other(String),
}

impl std::fmt::Display for GarminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GarminError::RateLimited => write!(f, "Garmin rate limit reached — try again later"),
            GarminError::Other(m) => write!(f, "{m}"),
        }
    }
}

/// Check the status, and turn a non-2xx answer into an error with Garmin's text.
async fn checked(res: Result<reqwest::Response, reqwest::Error>) -> Result<reqwest::Response, GarminError> {
    let res = res.map_err(|e| {
        // reqwest's Display hides the cause ("bad protocol version", …).
        let mut msg = format!("can't reach Garmin: {e}");
        let mut cause = std::error::Error::source(&e);
        while let Some(c) = cause {
            msg += &format!(": {c}");
            cause = c.source();
        }
        GarminError::Other(msg)
    })?;
    let status = res.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(GarminError::RateLimited);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let body: String = body.chars().take(200).collect();
        return Err(GarminError::Other(format!("Garmin answered {status}: {body}")));
    }
    Ok(res)
}

/// The token body is not documented: accept an OAuth2-style object, a JSON
/// string, or plain text.
fn parse_token(body: &str) -> Option<String> {
    let body = body.trim();
    let token = match serde_json::from_str::<serde_json::Value>(body) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(v @ serde_json::Value::Object(_)) => ["access_token", "accessToken", "token"]
            .iter()
            .find_map(|k| v.get(*k).and_then(|t| t.as_str()))?
            .to_string(),
        Ok(_) => return None,
        Err(_) => body.to_string(),
    };
    let ok = !token.is_empty() && !token.contains(char::is_whitespace);
    ok.then_some(token)
}

async fn access_token(key: &str) -> Result<String, GarminError> {
    let res = checked(
        http()
            .post(format!("{}{TOKEN_PATH}", api_base()))
            .header("Authorization", format!("ApiKey {key}"))
            .send()
            .await,
    )
    .await?;
    let body = res.text().await.map_err(|e| GarminError::Other(e.to_string()))?;
    parse_token(&body).ok_or_else(|| GarminError::Other("Garmin returned no access token".into()))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    activity_id: i64,
    #[serde(default)]
    activity_name: Option<String>,
    #[serde(rename = "startTimeGMT", default)]
    start_time_gmt: String,
    #[serde(default)]
    start_latitude: Option<f64>,
}

/// Activities that start after `after`, oldest first. Pages newest first
/// and stops at the first one at or before `after`.
async fn list_new(token: &str, after: Option<&str>) -> Result<Vec<Activity>, GarminError> {
    let mut out: Vec<Activity> = Vec::new();
    let mut start = 0usize;
    'pages: loop {
        let res = checked(
            http()
                .get(format!("{}{LIST_PATH}", api_base()))
                .bearer_auth(token)
                .query(&[
                    ("start", start.to_string()),
                    ("limit", PAGE.to_string()),
                    ("sortOrder", "desc".to_string()),
                ])
                .send()
                .await,
        )
        .await?;
        let page: Vec<Activity> = res
            .json()
            .await
            .map_err(|e| GarminError::Other(format!("activity list: {e}")))?;
        let n = page.len();
        for a in page {
            if after.is_some_and(|w| a.start_time_gmt.as_str() <= w) {
                break 'pages;
            }
            out.push(a);
        }
        if n < PAGE {
            break;
        }
        start += PAGE;
    }
    out.reverse();
    Ok(out)
}

async fn download(token: &str, id: i64) -> Result<Vec<u8>, GarminError> {
    let res = checked(
        http()
            .get(format!("{}/download-service/files/activity/{id}", api_base()))
            .bearer_auth(token)
            .send()
            .await,
    )
    .await?;
    let bytes = res.bytes().await.map_err(|e| GarminError::Other(e.to_string()))?;
    Ok(bytes.to_vec())
}

fn suffix(key: &str) -> String {
    let tail: Vec<char> = key.chars().rev().take(4).collect();
    format!("…{}", tail.into_iter().rev().collect::<String>())
}

// ---------------------------------------------------------------------------
// GET / and PUT / — the key
// ---------------------------------------------------------------------------

async fn status(Extension(pool): Extension<PgPool>) -> Result<Json<serde_json::Value>, ApiError> {
    let key = get_setting(&pool, KEY_SETTING).await?;
    Ok(Json(serde_json::json!({
        "connected": key.is_some(),
        "key_suffix": key.as_deref().map(suffix),
        "newest_ride": newest_ride(&pool).await?,
    })))
}

#[derive(Debug, Deserialize)]
struct KeyBody {
    /// null / empty disconnects.
    key: Option<String>,
}

/// Store a pasted key, but only after Garmin swaps it for a token, so a typo
/// fails here and not at the first sync.
async fn set_key(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<KeyBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let key = body.key.as_deref().map(str::trim).filter(|k| !k.is_empty());
    match key {
        None => set_setting(&pool, KEY_SETTING, None).await?,
        Some(key) => {
            access_token(key)
                .await
                .map_err(|e| bad_request(format!("key check failed: {e}")))?;
            set_setting(&pool, KEY_SETTING, Some(key)).await?;
        }
    }
    status(Extension(pool)).await
}

// ---------------------------------------------------------------------------
// POST /sync
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize)]
struct Failed {
    name: String,
    error: String,
}

#[derive(Debug, Default, Serialize)]
struct SyncResult {
    imported: usize,
    duplicates: usize,
    skipped_no_gps: usize,
    failed: Vec<Failed>,
    /// New activities left over after this batch (refresh again to get them).
    remaining: usize,
    rate_limited: bool,
}

/// Start of the newest own ride, in Garmin's `yyyy-MM-dd HH:mm:ss` UTC form so
/// a plain string compare with `startTimeGMT` orders them. A refresh pulls
/// only activities after it, so nothing older than what is already here
/// comes in again under another file hash.
async fn newest_ride(pool: &PgPool) -> Result<Option<String>, ApiError> {
    let newest: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT to_char(max(started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
         FROM rides WHERE origin = 'self'",
    )
    .fetch_optional(pool)
    .await
    .map_err(internal)?;
    Ok(newest.and_then(|(t,)| t))
}

/// Download one activity and ingest every track in its zip. Returns the new
/// ride ids (empty when every member was a duplicate).
async fn ingest_activity(
    pool: &PgPool,
    store: &dingo_ingest::FileStore,
    scratch: &std::path::Path,
    token: &str,
    a: &Activity,
) -> Result<Vec<Uuid>, GarminError> {
    let bytes = download(token, a.activity_id).await?;
    let zip_path = scratch.join(format!("{}.zip", a.activity_id));
    std::fs::write(&zip_path, &bytes).map_err(|e| GarminError::Other(e.to_string()))?;
    let out_dir = scratch.join(a.activity_id.to_string());
    // extract_tracks is blocking and its zip reader is !Send (see import.rs).
    let members = tokio::task::spawn_blocking(move || dingo_ingest::extract_tracks(&zip_path, &out_dir))
        .await
        .map_err(|e| GarminError::Other(e.to_string()))?
        .map_err(|e| GarminError::Other(e.to_string()))?;
    if members.is_empty() {
        return Err(GarminError::Other("no track file in the download".into()));
    }
    let mut ids = Vec::new();
    for m in &members {
        let res = dingo_ingest::ingest_file(pool, store, m, dingo_ingest::RideOrigin::Own)
            .await
            .map_err(|e| GarminError::Other(e.to_string()))?;
        ids.extend(res.ride_ids.iter().map(|r| r.0));
    }
    Ok(ids)
}

async fn sync(Extension(pool): Extension<PgPool>) -> Result<Json<SyncResult>, ApiError> {
    let key = get_setting(&pool, KEY_SETTING).await?.ok_or((
        StatusCode::UNAUTHORIZED,
        "Garmin not connected — paste a personal API key in Settings".to_string(),
    ))?;
    let config = dingo_core::Config::load().map_err(internal)?;
    let store = dingo_ingest::FileStore::new(&config.file_store_path).map_err(internal)?;

    let token = access_token(&key)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    let newest = newest_ride(&pool).await?;
    let mut todo = list_new(&token, newest.as_deref())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let mut out = SyncResult {
        remaining: todo.len().saturating_sub(BATCH),
        ..Default::default()
    };
    todo.truncate(BATCH);

    let scratch = std::env::temp_dir().join(format!("dingo-garmin-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).map_err(internal)?;
    let mut new_ids: Vec<Uuid> = Vec::new();
    for a in &todo {
        if a.start_latitude.is_none() {
            out.skipped_no_gps += 1;
            continue;
        }
        match ingest_activity(&pool, &store, &scratch, &token, a).await {
            Ok(ids) if ids.is_empty() => out.duplicates += 1,
            Ok(ids) => {
                out.imported += 1;
                new_ids.extend(ids);
            }
            Err(GarminError::RateLimited) => {
                out.rate_limited = true;
                break;
            }
            Err(GarminError::Other(error)) => out.failed.push(Failed {
                name: a.activity_name.clone().unwrap_or_else(|| format!("activity {}", a.activity_id)),
                error,
            }),
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);

    if !new_ids.is_empty() {
        sqlx::query("UPDATE rides SET source = 'garmin' WHERE id = ANY($1)")
            .bind(&new_ids)
            .execute(&pool)
            .await
            .map_err(internal)?;
        super::import::postprocess_new_rides(&pool, &config, new_ids).await;
    }
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GARMIN_API_URL is process-global; mock-server tests must not interleave.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn token_parses_every_documented_and_likely_shape() {
        assert_eq!(parse_token(r#"{"access_token":"abc","expires_in":86400}"#).as_deref(), Some("abc"));
        assert_eq!(parse_token(r#"{"accessToken":"abc"}"#).as_deref(), Some("abc"));
        assert_eq!(parse_token(r#""abc""#).as_deref(), Some("abc"));
        assert_eq!(parse_token("abc\n").as_deref(), Some("abc"));
        assert_eq!(parse_token(r#"{"error":"nope"}"#), None);
        assert_eq!(parse_token("<html> error page </html>"), None);
        assert_eq!(parse_token(""), None);
    }

    #[test]
    fn suffix_shows_only_the_tail() {
        assert_eq!(suffix("gk_abcdef1234"), "…1234");
        assert_eq!(suffix("ab"), "…ab");
    }

    /// A mock Garmin: the token endpoint checks the ApiKey header, the list
    /// serves 150 activities newest first in pages, the download serves bytes.
    async fn mock_garmin() -> std::net::SocketAddr {
        use axum::extract::{Path, Query};
        use axum::http::HeaderMap;
        let app = Router::new()
            .route(
                TOKEN_PATH,
                post(|h: HeaderMap| async move {
                    if h.get("authorization").and_then(|v| v.to_str().ok()) == Some("ApiKey good") {
                        Ok(Json(serde_json::json!({ "access_token": "tok", "expires_in": 86400 })))
                    } else {
                        Err(StatusCode::UNAUTHORIZED)
                    }
                }),
            )
            .route(
                LIST_PATH,
                get(|h: HeaderMap, Query(q): Query<std::collections::HashMap<String, String>>| async move {
                    if h.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer tok") {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    let start: usize = q["start"].parse().unwrap();
                    let limit: usize = q["limit"].parse().unwrap();
                    // ids 150..1, newest first; id n starts on day n.
                    let all: Vec<serde_json::Value> = (1..=150i64)
                        .rev()
                        .map(|n| {
                            serde_json::json!({
                                "activityId": n,
                                "activityName": format!("ride {n}"),
                                "startTimeGMT": format!("2026-01-01 00:00:00 +{n:03}"),
                                "startLatitude": if n % 2 == 0 { Some(-33.5) } else { None },
                            })
                        })
                        .collect();
                    Ok(Json(all.into_iter().skip(start).take(limit).collect::<Vec<_>>()))
                }),
            )
            .route(
                "/download-service/files/activity/{id}",
                get(|Path(id): Path<i64>| async move {
                    if id == 429 { Err(StatusCode::TOO_MANY_REQUESTS) } else { Ok(vec![80u8, 75, 3, 4]) }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn token_list_and_download_against_a_mock() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let addr = mock_garmin().await;
        // Test-only env mutation; nothing else in this process reads it.
        unsafe { std::env::set_var("GARMIN_API_URL", format!("http://{addr}")) };

        assert!(matches!(access_token("bad").await, Err(GarminError::Other(m)) if m.contains("401")));
        let token = access_token("good").await.expect("token");
        assert_eq!(token, "tok");

        // No newest ride: both pages, oldest first.
        let all = list_new(&token, None).await.expect("list");
        assert_eq!(all.len(), 150);
        assert_eq!(all[0].activity_id, 1);
        assert_eq!(all[149].activity_id, 150);
        assert_eq!(all[1].start_latitude, Some(-33.5));
        assert_eq!(all[0].start_latitude, None);

        // Newest ride at activity 120: only 121..=150 come back, oldest first.
        let w = all[119].start_time_gmt.clone();
        let newer = list_new(&token, Some(&w)).await.expect("list");
        assert_eq!(newer.iter().map(|a| a.activity_id).collect::<Vec<_>>(), (121..=150).collect::<Vec<_>>());

        assert_eq!(download(&token, 7).await.expect("download"), vec![80, 75, 3, 4]);
        assert_eq!(download(&token, 429).await, Err(GarminError::RateLimited));

        unsafe { std::env::remove_var("GARMIN_API_URL") };
    }
}
