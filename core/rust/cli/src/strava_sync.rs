//! `dingo strava` — pull your own new Strava activities into Dingo.
//!
//! One-time setup (needs a browser):
//!   1. Create a free API app at https://www.strava.com/settings/api
//!      (Authorization Callback Domain: localhost)
//!   2. Put STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .env
//!   3. `dingo strava auth` — opens/prints the authorize URL, catches the
//!      OAuth redirect on localhost:8723, stores tokens in
//!      ~/.config/dingo/strava.json
//!
//! Then `dingo strava sync` (cron-able) lists activities newer than the
//! newest ride in the DB, rebuilds each as GPX from the streams API (the API
//! has no raw-file export), and ingests them with source='strava'. Stream-
//! built GPX won't byte-match a Garmin original, so if you also import
//! Garmin/Strava archives, `dingo dedupe-rides` remains the tie-breaker.

use std::fmt::Write as _;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use sqlx::{PgPool, Row};

const AUTH_PORT: u16 = 8723;

fn token_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config/dingo/strava.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Tokens {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_at: i64,
    #[serde(default)]
    athlete: String,
}

fn save_tokens(t: &Tokens) -> anyhow::Result<()> {
    let path = token_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, serde_json::to_vec_pretty(t)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Interactive one-time OAuth: prints the authorize URL, waits for the
/// browser redirect on localhost, exchanges the code, saves tokens.
pub async fn auth() -> anyhow::Result<()> {
    let client_id = std::env::var("STRAVA_CLIENT_ID").map_err(|_| {
        anyhow::anyhow!(
            "STRAVA_CLIENT_ID not set. Create an API app at \
             https://www.strava.com/settings/api (callback domain: localhost) \
             and put STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .env"
        )
    })?;
    let client_secret = std::env::var("STRAVA_CLIENT_SECRET")
        .map_err(|_| anyhow::anyhow!("STRAVA_CLIENT_SECRET not set (see .env)"))?;

    let redirect = format!("http://localhost:{AUTH_PORT}/exchange");
    let url = format!(
        "https://www.strava.com/oauth/authorize?client_id={client_id}\
         &redirect_uri={redirect}&response_type=code&approval_prompt=auto\
         &scope=activity:read_all"
    );
    println!("🔑 Open this URL in your browser and approve access:\n\n   {url}\n");
    let _ = std::process::Command::new("open").arg(&url).spawn();

    // Tiny one-shot listener for the OAuth redirect
    let listener = TcpListener::bind(("127.0.0.1", AUTH_PORT))?;
    println!("   waiting for the redirect on localhost:{AUTH_PORT}…");
    let (mut stream, _) = listener.accept()?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf)?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let code = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|path| {
            path.split('?').nth(1)?.split('&').find_map(|kv| {
                kv.strip_prefix("code=").map(|v| v.to_string())
            })
        })
        .ok_or_else(|| anyhow::anyhow!("no ?code= in the redirect — was access denied?"))?;
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
          <h2>Dingo is connected to Strava \xe2\x9c\x85</h2>You can close this tab.",
    );

    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post("https://www.strava.com/oauth/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let tokens = Tokens {
        client_id,
        client_secret,
        refresh_token: resp["refresh_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("no refresh_token in response"))?
            .to_string(),
        access_token: resp["access_token"].as_str().unwrap_or("").to_string(),
        expires_at: resp["expires_at"].as_i64().unwrap_or(0),
        athlete: resp["athlete"]["username"]
            .as_str()
            .or(resp["athlete"]["firstname"].as_str())
            .unwrap_or("")
            .to_string(),
    };
    save_tokens(&tokens)?;
    println!(
        "✅ Connected{}. Tokens in {} — run `dingo strava sync` any time.",
        if tokens.athlete.is_empty() { String::new() } else { format!(" as {}", tokens.athlete) },
        token_path().display()
    );
    Ok(())
}

async fn fresh_access_token(client: &reqwest::Client) -> anyhow::Result<String> {
    let raw = std::fs::read(token_path()).map_err(|_| {
        anyhow::anyhow!("Not connected — run `dingo strava auth` first (see Docs/strava-sync.md)")
    })?;
    let mut tokens: Tokens = serde_json::from_slice(&raw)?;

    let resp: serde_json::Value = client
        .post("https://www.strava.com/oauth/token")
        .form(&[
            ("client_id", tokens.client_id.as_str()),
            ("client_secret", tokens.client_secret.as_str()),
            ("refresh_token", tokens.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if let Some(rt) = resp["refresh_token"].as_str() {
        tokens.refresh_token = rt.to_string(); // Strava rotates refresh tokens
    }
    tokens.access_token = resp["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("token refresh failed: {resp}"))?
        .to_string();
    tokens.expires_at = resp["expires_at"].as_i64().unwrap_or(0);
    let access = tokens.access_token.clone();
    save_tokens(&tokens)?;
    Ok(access)
}

/// Incremental pull: activities after the newest ride in the DB (or --since).
pub async fn sync(
    pool: &PgPool,
    file_store: &dingo_ingest::FileStore,
    since: Option<&str>,
    limit: usize,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let access = fresh_access_token(&client).await?;

    let after_epoch: i64 = match since {
        Some(s) => chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")?
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp(),
        None => {
            let row = sqlx::query("SELECT EXTRACT(EPOCH FROM max(started_at))::bigint AS t FROM rides")
                .fetch_one(pool)
                .await?;
            row.get::<Option<i64>, _>("t").unwrap_or(0)
        }
    };
    println!(
        "🔄 Pulling Strava activities after {}…",
        chrono::DateTime::from_timestamp(after_epoch, 0)
            .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
            .unwrap_or_else(|| "the beginning".into())
    );

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut failed_since: Option<String> = None; // oldest failed activity date
    let mut page = 1;
    // Note a GPS-bearing activity that failed to import, so the run can
    // suggest a --since to retry it (the watermark would otherwise advance
    // past it forever — audit M7).
    let note_fail = |start: &str, failed: &mut Option<String>| {
        if start.is_empty() { return; }
        match failed {
            Some(cur) if start >= cur.as_str() => {}
            _ => *failed = Some(start.to_string()),
        }
    };
    'pages: loop {
        // A failure listing activities ends paging but still runs clean/name
        // on what we imported (audit M6) — never `?` out of the whole sync.
        let acts: Vec<serde_json::Value> = match client
            .get("https://www.strava.com/api/v3/athlete/activities")
            .bearer_auth(&access)
            .query(&[
                ("after", after_epoch.to_string()),
                ("per_page", "50".into()),
                ("page", page.to_string()),
            ])
            .send()
            .await
            .and_then(|r| r.error_for_status())
        {
            Ok(r) => r.json().await.unwrap_or_default(),
            Err(e) => {
                eprintln!("   ⚠ activity list failed ({e}) — stopping after {imported} imported");
                break 'pages;
            }
        };
        if acts.is_empty() {
            break;
        }
        for act in &acts {
            if imported >= limit {
                println!("   --limit {limit} reached");
                break 'pages;
            }
            let id = act["id"].as_i64().unwrap_or(0);
            let name = act["name"].as_str().unwrap_or("Strava activity");
            let start = act["start_date"].as_str().unwrap_or("");
            // Manual/trainer entries have no GPS
            if act["manual"].as_bool() == Some(true) || act["trainer"].as_bool() == Some(true) {
                skipped += 1;
                continue;
            }

            // Fetch streams with rate-limit awareness: on 429, honour
            // Retry-After (or wait 15 min) and retry rather than aborting the
            // whole run before clean/name (audit M6). A single stream error
            // (404/500) skips that activity, not the run (audit M7 partial).
            let resp = client
                .get(format!("https://www.strava.com/api/v3/activities/{id}/streams"))
                .bearer_auth(&access)
                .query(&[("keys", "time,latlng,altitude,heartrate"), ("key_by_type", "true")])
                .send()
                .await;
            let streams: serde_json::Value = match resp {
                Ok(r) if r.status().as_u16() == 429 => {
                    let wait = r
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(900);
                    println!("   ⏳ rate limited — waiting {wait}s (imported {imported} so far)…");
                    tokio::time::sleep(std::time::Duration::from_secs(wait.min(900))).await;
                    // Re-issue once; give up on this activity if it still fails.
                    match client
                        .get(format!("https://www.strava.com/api/v3/activities/{id}/streams"))
                        .bearer_auth(&access)
                        .query(&[("keys", "time,latlng,altitude,heartrate"), ("key_by_type", "true")])
                        .send()
                        .await
                        .and_then(|r| r.error_for_status())
                    {
                        Ok(r) => r.json().await.unwrap_or(serde_json::Value::Null),
                        Err(e) => { eprintln!("   ⚠ {name}: {e}"); skipped += 1; continue; }
                    }
                }
                Ok(r) => match r.error_for_status() {
                    Ok(r) => r.json().await.unwrap_or(serde_json::Value::Null),
                    Err(e) => { eprintln!("   ⚠ {name}: {e}"); skipped += 1; continue; }
                },
                Err(e) => { eprintln!("   ⚠ {name}: {e}"); skipped += 1; continue; }
            };
            let Some(gpx) = streams_to_gpx(name, start, &streams) else {
                skipped += 1;
                continue;
            };

            let tmp = std::env::temp_dir().join(format!("strava-{id}.gpx"));
            std::fs::write(&tmp, &gpx)?;
            let res = dingo_ingest::ingest_file(pool, file_store, &tmp, dingo_ingest::RideOrigin::Own).await;
            let _ = std::fs::remove_file(&tmp);
            match res {
                Ok(r) if !r.was_duplicate && !r.ride_ids.is_empty() => {
                    let ids: Vec<sqlx::types::Uuid> = r.ride_ids.iter().map(|x| x.0).collect();
                    sqlx::query("UPDATE rides SET source = 'strava' WHERE id = ANY($1)")
                        .bind(&ids)
                        .execute(pool)
                        .await?;
                    imported += 1;
                    println!("   ⬇ {name} ({start})");
                }
                Ok(_) => skipped += 1,
                Err(e) => {
                    skipped += 1;
                    note_fail(start, &mut failed_since);
                    eprintln!("   ⚠ {name}: {e}");
                }
            }
        }
        page += 1;
    }

    if imported > 0 {
        println!("🧹 Cleaning + locating…");
        dingo_geo::clean_all_rides(pool, &dingo_geo::CleaningConfig::default()).await?;
        if let Err(e) = dingo_enrich::name_unlocated_rides(pool).await {
            eprintln!("   naming failed (gazetteer empty?): {e}");
        }
    }
    println!("✅ Strava sync: {imported} imported, {skipped} skipped");
    if let Some(since) = failed_since {
        let day = since.get(..10).unwrap_or(&since);
        println!("   ⚠ some activities failed to import — retry them with `dingo strava sync --since {day}`");
    }
    if imported > 0 {
        println!("   Run `dingo dedupe-rides` if these overlap other imports.");
    }
    Ok(())
}

/// Rebuild a GPX from Strava streams. `None` when there's no usable latlng.
fn streams_to_gpx(name: &str, start_date: &str, streams: &serde_json::Value) -> Option<String> {
    let latlng = streams["latlng"]["data"].as_array()?;
    if latlng.len() < 2 {
        return None;
    }
    let time = streams["time"]["data"].as_array();
    let alt = streams["altitude"]["data"].as_array();
    let hr = streams["heartrate"]["data"].as_array();
    let start = chrono::DateTime::parse_from_rfc3339(start_date).ok();

    let mut gpx = String::with_capacity(latlng.len() * 90);
    gpx.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    gpx.push_str(
        "<gpx version=\"1.1\" creator=\"Dingo strava sync\" \
         xmlns=\"http://www.topografix.com/GPX/1/1\" \
         xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">\n",
    );
    let esc = dingo_export::xml_escape(name);
    let _ = writeln!(gpx, "  <metadata><name>{esc}</name></metadata>");
    let _ = writeln!(gpx, "  <trk><name>{esc}</name><trkseg>");
    for (i, ll) in latlng.iter().enumerate() {
        let (Some(lat), Some(lon)) = (ll[0].as_f64(), ll[1].as_f64()) else { continue };
        let _ = write!(gpx, "    <trkpt lat=\"{lat:.7}\" lon=\"{lon:.7}\">");
        if let Some(e) = alt.and_then(|a| a.get(i)).and_then(|v| v.as_f64()) {
            let _ = write!(gpx, "<ele>{e:.1}</ele>");
        }
        if let (Some(s), Some(offs)) = (start, time.and_then(|t| t.get(i)).and_then(|v| v.as_i64())) {
            let ts = s + chrono::Duration::seconds(offs);
            let _ = write!(gpx, "<time>{}</time>", ts.to_utc().format("%Y-%m-%dT%H:%M:%SZ"));
        }
        if let Some(h) = hr.and_then(|a| a.get(i)).and_then(|v| v.as_i64()) {
            let _ = write!(
                gpx,
                "<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{h}</gpxtpx:hr>\
                 </gpxtpx:TrackPointExtension></extensions>"
            );
        }
        gpx.push_str("</trkpt>\n");
    }
    gpx.push_str("  </trkseg></trk>\n</gpx>\n");
    Some(gpx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_to_gpx_builds_track_with_time_ele_hr() {
        let streams = serde_json::json!({
            "latlng": { "data": [[-33.5, 151.2], [-33.51, 151.21], [-33.52, 151.22]] },
            "time": { "data": [0, 30, 65] },
            "altitude": { "data": [102.4, 110.0, 95.2] },
            "heartrate": { "data": [120, 135, 142] },
        });
        let gpx = streams_to_gpx("Test <ride>", "2026-07-12T01:00:00Z", &streams).unwrap();
        assert!(gpx.contains("Test &lt;ride&gt;"));
        assert!(gpx.contains("lat=\"-33.5100000\" lon=\"151.2100000\""));
        assert!(gpx.contains("<ele>110.0</ele>"));
        assert!(gpx.contains("<time>2026-07-12T01:00:30Z</time>"));
        assert!(gpx.contains("<gpxtpx:hr>142</gpxtpx:hr>"));
        assert_eq!(gpx.matches("<trkpt").count(), 3);
    }

    #[test]
    fn streams_to_gpx_rejects_no_gps() {
        let streams = serde_json::json!({ "time": { "data": [0, 30] } });
        assert!(streams_to_gpx("x", "2026-07-12T01:00:00Z", &streams).is_none());
    }

    #[test]
    fn streams_to_gpx_rejects_single_point() {
        let streams = serde_json::json!({ "latlng": { "data": [[-33.5, 151.2]] } });
        assert!(streams_to_gpx("x", "2026-07-12T01:00:00Z", &streams).is_none());
    }

    #[test]
    fn streams_to_gpx_tolerates_short_aux_streams() {
        // altitude/hr shorter than latlng must not panic; missing entries just
        // omit ele/hr for those points.
        let streams = serde_json::json!({
            "latlng": { "data": [[-33.5, 151.2], [-33.51, 151.21], [-33.52, 151.22]] },
            "altitude": { "data": [102.0] },
            "heartrate": { "data": [120, 130] },
        });
        let gpx = streams_to_gpx("x", "2026-07-12T01:00:00Z", &streams).unwrap();
        assert_eq!(gpx.matches("<trkpt").count(), 3);
        assert_eq!(gpx.matches("<ele>").count(), 1);
        assert_eq!(gpx.matches("<gpxtpx:hr>").count(), 2);
    }

    #[test]
    fn streams_to_gpx_null_gps_entry_skipped() {
        let streams = serde_json::json!({
            "latlng": { "data": [[-33.5, 151.2], null, [-33.52, 151.22]] },
        });
        let gpx = streams_to_gpx("x", "2026-07-12T01:00:00Z", &streams).unwrap();
        // The null pair is skipped; two valid points remain.
        assert_eq!(gpx.matches("<trkpt").count(), 2);
    }
}
