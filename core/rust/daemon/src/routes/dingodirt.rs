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

/// Multipart-upload a built bundle to `{site}/api/packs`. Site errors come
/// back verbatim with their status so Plan can show them.
pub async fn upload_pack(
    token: &str,
    filename: &str,
    bytes: Vec<u8>,
    visibility: &str,
    site_pack_id: Option<&str>,
) -> Result<SitePack, ApiError> {
    let mut form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes)
                .file_name(filename.to_string())
                .mime_str("application/zip")
                .map_err(internal)?,
        )
        .text("visibility", visibility.to_string());
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

        let got = upload_pack("ddt_secret", "Kandos.dingonav", vec![80, 75, 3, 4], "public", Some("site-id-1"))
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
