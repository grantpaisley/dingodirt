//! Fetching heat tiles from Strava's CDN.
//!
//! The real global-heatmap tiles live at
//! `content-a.strava.com/identified/globalheat/sport_Ride/grayscale/{z}/{x}/{y}.png`
//! (standard XYZ, z14 max, raw grayscale intensity) and are CloudFront
//! cookie-gated. Cookies are needed only during *acquisition* — once mirrored,
//! the archive serves forever without them.

use anyhow::{Context, Result, bail};
use sqlx::{PgPool, Row};
use std::time::Duration;

/// Default tile URL template; override with `DINGO_HEAT_URL` (must contain
/// `{z}`, `{x}`, `{y}` placeholders) e.g. for a different sport or a test server.
const DEFAULT_URL: &str =
    "https://content-a.strava.com/identified/globalheat/sport_Ride/grayscale/{z}/{x}/{y}.png";

/// One tile-fetch result, classified for the worker's descent logic.
pub enum Outcome {
    /// 200 — PNG bytes (may still measure as heat-empty).
    Tile(Vec<u8>),
    /// 404 — no data for this tile; prune.
    Missing,
    /// 401/403 — cookies expired/rejected. Abort the run; retrying burns tiles.
    AuthRejected(String),
    /// 429/5xx/network — worth backing off and retrying.
    Transient(String),
}

pub struct Fetcher {
    client: reqwest::Client,
    url_template: String,
    cookie: String,
}

impl Fetcher {
    /// Resolve cookies and build the client. Cookie precedence:
    /// 1. `STRAVA_HEAT_COOKIES` env — a raw `Cookie:` header value.
    /// 2. The daemon's `strava_heatmap_cookies` table (pasted via the old
    ///    StravaConnect panel). Queried at runtime so this keeps compiling
    ///    after phase 2 drops that table.
    pub async fn new(pool: &PgPool) -> Result<Self> {
        let url_template =
            std::env::var("DINGO_HEAT_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());
        for ph in ["{z}", "{x}", "{y}"] {
            if !url_template.contains(ph) {
                bail!("DINGO_HEAT_URL is missing the {ph} placeholder");
            }
        }
        let cookie = match std::env::var("STRAVA_HEAT_COOKIES") {
            Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
            _ => cookie_from_db(pool).await?.context(
                "no Strava cookies: set STRAVA_HEAT_COOKIES (raw Cookie header from a \
                 logged-in browser's heat-tile request) or paste them via the web UI's \
                 Strava connect panel",
            )?,
        };
        let client = reqwest::Client::builder()
            .user_agent("dingo-harvest/0.1")
            .timeout(Duration::from_secs(30))
            .build()
            .context("build http client")?;
        Ok(Self { client, url_template, cookie })
    }

    pub async fn fetch(&self, z: u32, x: u32, y: u32) -> Outcome {
        let url = self
            .url_template
            .replace("{z}", &z.to_string())
            .replace("{x}", &x.to_string())
            .replace("{y}", &y.to_string());
        let resp = match self
            .client
            .get(&url)
            .header(reqwest::header::COOKIE, &self.cookie)
            .header(reqwest::header::REFERER, "https://www.strava.com/maps/global-heatmap")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return Outcome::Transient(format!("request failed: {e}")),
        };
        match resp.status().as_u16() {
            200 => match resp.bytes().await {
                Ok(b) => Outcome::Tile(b.to_vec()),
                Err(e) => Outcome::Transient(format!("body read failed: {e}")),
            },
            404 => Outcome::Missing,
            s @ (401 | 403) => {
                // CloudFront explains itself in a short XML body (MissingKey /
                // InvalidKey / expired) — surface it for diagnosis.
                let body = resp.text().await.unwrap_or_default();
                Outcome::AuthRejected(format!("{s}: {}", body.trim()))
            }
            s => Outcome::Transient(format!("upstream {s}")),
        }
    }
}

/// Best-effort read of the legacy pasted-cookie table; `Ok(None)` if the table
/// is gone (post-phase-2) or empty.
async fn cookie_from_db(pool: &PgPool) -> Result<Option<String>> {
    let row = sqlx::query(
        "SELECT key_pair_id, policy, signature, idcf FROM strava_heatmap_cookies WHERE id = TRUE",
    )
    .fetch_optional(pool)
    .await;
    match row {
        Ok(Some(r)) => {
            let (k, p, s): (String, String, String) =
                (r.get("key_pair_id"), r.get("policy"), r.get("signature"));
            let mut header = format!(
                "CloudFront-Key-Pair-Id={k}; CloudFront-Policy={p}; CloudFront-Signature={s}"
            );
            // The identified/ endpoint also wants the _strava_idcf JWT.
            if let Some(idcf) = r.get::<Option<String>, _>("idcf") {
                header.push_str("; _strava_idcf=");
                header.push_str(&idcf);
            }
            Ok(Some(header))
        }
        Ok(None) => Ok(None),
        Err(_) => Ok(None), // table missing — fall through to the env-var hint
    }
}
