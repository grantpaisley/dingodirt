//! dingodirt.com connection: the pasted API token and the pack upload.
//!
//! Plan publishes packs to the website (which owns share links, versioning
//! and moderation — docs/plans/2026-08-06-plan-publish-to-dingodirt-design.md).
//! The token is minted on the site's dashboard and pasted once into Plan's
//! Settings; it lives in app_settings on this machine and is never echoed
//! back beyond a suffix.

use axum::http::StatusCode;
use axum::{Json, Router, extract::Extension, routing::get};
use serde::Deserialize;
use sqlx::PgPool;

use super::export::{ApiError, bad_request, internal};

pub const TOKEN_KEY: &str = "dingodirt_api_token";

pub fn routes() -> Router {
    Router::new().route("/", get(status).put(set_token))
}

/// Site base URL; env-overridable so a self-hosted dingodirt works too.
pub fn site_base() -> String {
    std::env::var("DINGO_SITE_URL")
        .unwrap_or_else(|_| "https://dingodirt.com".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("reqwest client")
    })
}

/// Client for the presigned blob PUT — a 40+ MB pack on a slow uplink can
/// easily outlive the 120 s API timeout.
fn http_upload() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(900))
            .build()
            .expect("reqwest client")
    })
}

pub async fn get_setting(pool: &PgPool, key: &str) -> Result<Option<String>, ApiError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM app_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(internal)?;
    Ok(row.map(|(v,)| v))
}

async fn set_setting(pool: &PgPool, key: &str, value: Option<&str>) -> Result<(), ApiError> {
    match value {
        Some(v) => {
            sqlx::query(
                "INSERT INTO app_settings (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            )
            .bind(key)
            .bind(v)
            .execute(pool)
            .await
            .map_err(internal)?;
        }
        None => {
            sqlx::query("DELETE FROM app_settings WHERE key = $1")
                .bind(key)
                .execute(pool)
                .await
                .map_err(internal)?;
        }
    }
    Ok(())
}

/// The stored token, or the 401 that tells Plan to send the user to Settings.
pub async fn require_token(pool: &PgPool) -> Result<String, ApiError> {
    get_setting(pool, TOKEN_KEY).await?.ok_or((
        StatusCode::UNAUTHORIZED,
        "Not connected to dingodirt.com — paste an API token in Settings".to_string(),
    ))
}

/// `GET {site}/api/me` for a token → (name, email, trusted) or the site's
/// error message.
async fn site_me(token: &str) -> Result<(String, String, bool), String> {
    let url = format!("{}/api/me", site_base());
    let res = http()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("can't reach {url}: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("token rejected")
            .to_string());
    }
    Ok((
        body.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        body.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        body.get("trusted").and_then(|v| v.as_bool()).unwrap_or(false),
    ))
}

fn suffix(token: &str) -> String {
    let tail: String = token
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("ddt_…{tail}")
}

/// Connection status for Plan's Settings card. Never returns the token.
async fn status(Extension(pool): Extension<PgPool>) -> Result<Json<serde_json::Value>, ApiError> {
    let Some(token) = get_setting(&pool, TOKEN_KEY).await? else {
        return Ok(Json(serde_json::json!({ "connected": false })));
    };
    match site_me(&token).await {
        Ok((name, email, trusted)) => Ok(Json(serde_json::json!({
            "connected": true,
            "name": name,
            "email": email,
            "trusted": trusted,
            "token_suffix": suffix(&token),
            "site": site_base(),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "connected": false,
            "token_suffix": suffix(&token),
            "error": e,
            "site": site_base(),
        }))),
    }
}

#[derive(Debug, Deserialize)]
struct TokenBody {
    /// null / empty clears the stored token (disconnect).
    token: Option<String>,
}

/// Store a pasted token — only after the site confirms it works, so a typo
/// can't silently break publishing later.
async fn set_token(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<TokenBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = body.token.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let Some(token) = token else {
        set_setting(&pool, TOKEN_KEY, None).await?;
        return Ok(Json(serde_json::json!({ "connected": false })));
    };
    let (name, email, trusted) = site_me(token)
        .await
        .map_err(|e| bad_request(format!("token check failed: {e}")))?;
    set_setting(&pool, TOKEN_KEY, Some(token)).await?;
    Ok(Json(serde_json::json!({
        "connected": true,
        "name": name,
        "email": email,
        "trusted": trusted,
        "token_suffix": suffix(token),
        "site": site_base(),
    })))
}

/// What the site tells us about a pack after an upload.
pub struct SitePack {
    pub id: String,
    pub share_token: String,
    pub visibility: String,
    pub version: i64,
    pub is_new: bool,
}

/// Bundles above this take the presigned path: Vercel caps serverless
/// request bodies at 4.5 MB, so the multipart route can't carry real packs.
/// Margin under the cap covers multipart framing overhead.
const MULTIPART_MAX_BYTES: usize = 3_500_000;

/// Upload a built bundle to the site. Small files go multipart to
/// `{site}/api/packs`; anything bigger is PUT straight to Blob storage via
/// a presigned URL, then confirmed with `{site}/api/packs/complete`. Site
/// errors come back verbatim with their status so Plan can show them.
pub async fn upload_pack(
    token: &str,
    filename: &str,
    bytes: Vec<u8>,
    visibility: Option<&str>,
    site_pack_id: Option<&str>,
) -> Result<SitePack, ApiError> {
    if bytes.len() > MULTIPART_MAX_BYTES {
        upload_pack_presigned(token, filename, bytes, visibility, site_pack_id).await
    } else {
        upload_pack_multipart(token, filename, bytes, visibility, site_pack_id).await
    }
}

async fn upload_pack_multipart(
    token: &str,
    filename: &str,
    bytes: Vec<u8>,
    visibility: Option<&str>,
    site_pack_id: Option<&str>,
) -> Result<SitePack, ApiError> {
    let mut form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.to_string())
            .mime_str("application/zip")
            .map_err(internal)?,
    );
    // No visibility field → the site keeps the pack's current visibility.
    if let Some(v) = visibility {
        form = form.text("visibility", v.to_string());
    }
    if let Some(id) = site_pack_id {
        form = form.text("packId", id.to_string());
    }
    let url = format!("{}/api/packs", site_base());
    let res = http()
        .post(&url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("can't reach dingodirt.com ({url}): {e}"),
            )
        })?;
    parse_pack_response(res).await
}

/// Three-step big-pack publish: mint a presigned URL, PUT the bytes to Blob
/// storage, then ask the site to validate and version the upload.
async fn upload_pack_presigned(
    token: &str,
    filename: &str,
    bytes: Vec<u8>,
    visibility: Option<&str>,
    site_pack_id: Option<&str>,
) -> Result<SitePack, ApiError> {
    let url = format!("{}/api/packs/upload", site_base());
    let res = http()
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "filename": filename, "size": bytes.len() }))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("can't reach dingodirt.com ({url}): {e}"),
            )
        })?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            body.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("upload set-up failed")
                .to_string(),
        ));
    }
    let get_str = |k: &str| {
        body.get(k)
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| internal(format!("site response missing {k}")))
    };
    let upload_url = get_str("uploadUrl")?;
    let pathname = get_str("pathname")?;

    let res = http_upload()
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, "application/zip")
        .body(bytes)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("blob upload failed: {e}")))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "blob upload rejected ({status}): {}",
                text.chars().take(200).collect::<String>()
            ),
        ));
    }
    // The store may rewrite the pathname (it random-suffixes unless told
    // not to, and its `pathname` field omits the suffix). The `url` path is
    // the real object name — trust it over both the minted value and the
    // response's pathname field so /complete looks in the right place.
    let stored: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let pathname = stored
        .get("url")
        .and_then(|v| v.as_str())
        .and_then(|u| reqwest::Url::parse(u).ok())
        .map(|u| percent_decode(u.path().trim_start_matches('/')))
        .filter(|p| !p.is_empty())
        .unwrap_or(pathname);
    tracing::info!("blob PUT ok; stored as {pathname}");

    let mut payload = serde_json::json!({ "pathname": pathname, "filename": filename });
    if let Some(v) = visibility {
        payload["visibility"] = v.into();
    }
    if let Some(id) = site_pack_id {
        payload["packId"] = id.into();
    }
    let url = format!("{}/api/packs/complete", site_base());
    let res = http()
        .post(&url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("can't reach dingodirt.com ({url}): {e}"),
            )
        })?;
    parse_pack_response(res).await
}

/// Undo URL percent-encoding (a blob pathname with spaces comes back as
/// `%20` in the store's object URL).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Shared tail of both upload paths: surface site errors verbatim, or parse
/// the `{ pack, version, isNew }` success body into a SitePack.
async fn parse_pack_response(res: reqwest::Response) -> Result<SitePack, ApiError> {
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("publish failed")
            .to_string();
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            msg,
        ));
    }
    let pack = body.get("pack").ok_or_else(|| internal("site response has no pack"))?;
    let get_str = |k: &str| {
        pack.get(k)
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| internal(format!("site response missing pack.{k}")))
    };
    Ok(SitePack {
        id: get_str("id")?,
        share_token: get_str("shareToken")?,
        visibility: get_str("visibility")?,
        version: body.get("version").and_then(|v| v.as_i64()).unwrap_or(1),
        is_new: body.get("isNew").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DINGO_SITE_URL is process-global; tests that point it at a mock
    /// site must not interleave.
    static SITE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn suffix_shows_only_the_tail() {
        assert_eq!(suffix("ddt_abcdefgh1234"), "ddt_…1234");
        assert_eq!(suffix("ab"), "ddt_…ab");
    }

    /// upload_pack against a mock site: bearer + multipart fields go up,
    /// the response parses into a SitePack, and site errors pass through.
    #[tokio::test]
    async fn upload_pack_roundtrip() {
        use axum::routing::post;
        let _guard = SITE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<(String, String)>(1);
        let app = Router::new().route(
            "/api/packs",
            post(move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let tx = tx.clone();
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    tx.send((auth, String::from_utf8_lossy(&body).into_owned()))
                        .await
                        .ok();
                    Json(serde_json::json!({
                        "ok": true, "isNew": false, "version": 3,
                        "pack": { "id": "site-id-1", "name": "Kandos",
                                  "shareToken": "tok123", "visibility": "pending" }
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // Test-only env mutation; nothing else in this process reads it.
        unsafe { std::env::set_var("DINGO_SITE_URL", format!("http://{addr}")) };

        let got = upload_pack("ddt_secret", "Kandos.dingonav", vec![80, 75, 3, 4], Some("public"), Some("site-id-1"))
            .await
            .expect("upload should succeed");
        assert_eq!(got.id, "site-id-1");
        assert_eq!(got.share_token, "tok123");
        assert_eq!(got.visibility, "pending");
        assert_eq!(got.version, 3);
        assert!(!got.is_new);

        let (auth, body) = rx.recv().await.expect("mock saw the request");
        assert_eq!(auth, "Bearer ddt_secret");
        assert!(body.contains("name=\"file\""));
        assert!(body.contains("Kandos.dingonav"));
        assert!(body.contains("name=\"visibility\""));
        assert!(body.contains("public"));
        assert!(body.contains("name=\"packId\""));

        unsafe { std::env::remove_var("DINGO_SITE_URL") };
    }

    /// Big bundles skip multipart: mint a presigned URL, PUT raw bytes to
    /// the (mock) blob store, then confirm via /api/packs/complete.
    #[tokio::test]
    async fn upload_pack_presigned_roundtrip() {
        use axum::routing::{post, put};
        let _guard = SITE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (blob_tx, mut blob_rx) = tokio::sync::mpsc::channel::<usize>(1);
        let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<(String, String)>(1);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/api/packs/upload",
                post(move |body: Json<serde_json::Value>| async move {
                    assert_eq!(
                        body.get("filename").and_then(|v| v.as_str()),
                        Some("Flinders.dingonav")
                    );
                    Json(serde_json::json!({
                        "ok": true,
                        "uploadUrl": format!("http://{addr}/blob/uploads/u1/x/Flinders.dingonav"),
                        "pathname": "uploads/u1/x/Flinders.dingonav",
                    }))
                }),
            )
            .route(
                "/blob/{*path}",
                put(move |body: axum::body::Bytes| {
                    let blob_tx = blob_tx.clone();
                    async move {
                        blob_tx.send(body.len()).await.ok();
                        // Real store echoes the object URL; a suffixed name
                        // here proves the daemon trusts it over the minted
                        // pathname.
                        Json(serde_json::json!({
                            "url": "https://s.public.blob.vercel-storage.com/uploads/u1/x/Flinders-abc123.dingonav",
                            "pathname": "uploads/u1/x/Flinders.dingonav",
                        }))
                    }
                })
                .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)),
            )
            .route(
                "/api/packs/complete",
                post(move |headers: axum::http::HeaderMap, body: Json<serde_json::Value>| {
                    let done_tx = done_tx.clone();
                    async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        done_tx.send((auth, body.to_string())).await.ok();
                        Json(serde_json::json!({
                            "ok": true, "isNew": true, "version": 1,
                            "pack": { "id": "site-id-2", "name": "Flinders",
                                      "shareToken": "tok456", "visibility": "unlisted" }
                        }))
                    }
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // Test-only env mutation; guarded by SITE_ENV_LOCK.
        unsafe { std::env::set_var("DINGO_SITE_URL", format!("http://{addr}")) };

        let big = vec![0u8; MULTIPART_MAX_BYTES + 1];
        let sent = big.len();
        let got = upload_pack("ddt_secret", "Flinders.dingonav", big, Some("unlisted"), None)
            .await
            .expect("presigned upload should succeed");
        assert_eq!(got.id, "site-id-2");
        assert_eq!(got.share_token, "tok456");
        assert_eq!(got.visibility, "unlisted");
        assert_eq!(got.version, 1);
        assert!(got.is_new);

        assert_eq!(blob_rx.recv().await, Some(sent));
        let (auth, body) = done_rx.recv().await.expect("mock saw complete");
        assert_eq!(auth, "Bearer ddt_secret");
        // The suffixed name from the store's PUT response, not the minted one.
        assert!(body.contains("uploads/u1/x/Flinders-abc123.dingonav"));
        assert!(body.contains("unlisted"));
        assert!(!body.contains("packId"));

        unsafe { std::env::remove_var("DINGO_SITE_URL") };
    }
}

/// Soft-delete the site pack (the "also remove from dingodirt.com" path).
pub async fn delete_site_pack(token: &str, site_pack_id: &str) -> Result<(), ApiError> {
    let url = format!("{}/api/packs/id/{site_pack_id}", site_base());
    let res = http()
        .delete(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("can't reach dingodirt.com: {e}")))?;
    let status = res.status();
    // 404 = already gone on the site; that must not block the local delete.
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    Err((
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        body.get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("site delete failed")
            .to_string(),
    ))
}
