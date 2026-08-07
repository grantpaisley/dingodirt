//! Road closures API — live "can I actually ride that road?" overlay.
//!
//! Two upstreams, both free and keyless (see
//! docs/plans/plan-2026-08-07-road-closures-design.md):
//!
//! - SA DIT Outback Road Warnings (ArcGIS, native GeoJSON): curated polylines
//!   of the outback tracks with open/warning/4WD/closed status. Served whole —
//!   it IS the region of interest.
//! - VicTraffic's aggregate disruptions API: ~20k records covering VIC and all
//!   of NSW (~29 MB paginated), so the daemon pulls + caches it and serves only
//!   hard closures within ~50 km of tracks already in the library (rides +
//!   planned routes) — a relevance filter, so degree-based ST_DWithin is fine.
//!
//! Closures are advisory: a "closed" road is often passable on a bike, so the
//! payload keeps the full source text and a per-closure source URL and the UI
//! never changes routing behaviour.

use axum::{Json, Router, extract::Extension, routing::get};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tracing::warn;

/// Upstream cache TTL — closures change on flood timescales, not minutes, and
/// the VicTraffic pull is ~29 MB across 11 pages.
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

const SA_URL: &str = "https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/FNRR2/MapServer/0/query?where=STATUS%20%3E%3D%202&outFields=OBJECTID,ROAD_SECTION,STATUS,DESCRIPTION,COMMENTS,AREA_NAME&f=geojson";
const VICTRAFFIC_URL: &str = "https://api.traffic.transport.vic.gov.au/disruptions";

/// How far (degrees, ~50 km) a NSW/VIC closure may sit from a library track
/// and still be shown.
const NEAR_TRACKS_DEG: f64 = 0.45;

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // VicTraffic's CloudFront 403s non-browser agents
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Dingo/closures")
            .timeout(Duration::from_secs(30))
            .build()
            .expect("build reqwest client")
    })
}

pub fn routes() -> Router {
    Router::new().route("/", get(get_closures))
}

#[derive(Serialize)]
struct ClosuresBody {
    #[serde(rename = "type")]
    kind: &'static str,
    features: Vec<Value>,
    /// Upstreams that failed this refresh — the map still renders the rest.
    warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Upstream fetch + disk cache
// ---------------------------------------------------------------------------

fn cache_path(name: &str) -> PathBuf {
    let base = dingo_core::Config::load()
        .map(|c| c.file_store_path)
        .unwrap_or_else(|_| PathBuf::from("./files"));
    base.join("closures").join(name)
}

fn read_fresh(path: &PathBuf) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    let age = SystemTime::now().duration_since(meta.modified().ok()?).ok()?;
    if age > CACHE_TTL {
        return None;
    }
    std::fs::read(path).ok()
}

fn write_cache(path: &PathBuf, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(path, bytes);
    }
}

async fn fetch_sa() -> anyhow::Result<Value> {
    let path = cache_path("sa.json");
    if let Some(bytes) = read_fresh(&path) {
        return Ok(serde_json::from_slice(&bytes)?);
    }
    let bytes = http().get(SA_URL).send().await?.error_for_status()?.bytes().await?;
    let val: Value = serde_json::from_slice(&bytes)?;
    // ArcGIS reports errors as 200 + {"error": …}; don't cache those
    if val.get("error").is_some() || val.get("features").is_none() {
        anyhow::bail!("SA feed returned no features");
    }
    write_cache(&path, &bytes);
    Ok(val)
}

/// Pull every page of the VicTraffic aggregate and cache the flattened item
/// list. ~11 pages of ~2000 items.
async fn fetch_victraffic() -> anyhow::Result<Vec<Value>> {
    let path = cache_path("victraffic.json");
    if let Some(bytes) = read_fresh(&path) {
        return Ok(serde_json::from_slice(&bytes)?);
    }
    let mut items: Vec<Value> = Vec::new();
    let mut cursor = String::from("0");
    for _page in 0..20 {
        let val: Value = http()
            .get(VICTRAFFIC_URL)
            .query(&[("baselineId", "0"), ("lastSeenId", "0"), ("cursor", cursor.as_str())])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let page_items = val
            .pointer("/state/items")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow::anyhow!("VicTraffic page missing state.items"))?;
        items.extend(page_items.values().filter_map(|v| v.get("data").cloned()));
        let total = val.pointer("/meta/total").and_then(Value::as_str).map(String::from)
            .or_else(|| val.pointer("/meta/total").and_then(Value::as_u64).map(|n| n.to_string()))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        match val.pointer("/meta/cursor").and_then(Value::as_str) {
            Some(next) if !next.is_empty() && items.len() < total => cursor = next.to_string(),
            _ => break,
        }
    }
    write_cache(&path, &serde_json::to_vec(&items)?);
    Ok(items)
}

// ---------------------------------------------------------------------------
// VicTraffic geometry — encoded polylines, precision 5, LON-first pairs
// ---------------------------------------------------------------------------

/// NSW records carry HTML (`<p><strong>…`) in their descriptions — flatten to
/// plain text for the card.
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                // Block-ish tag boundaries become line breaks, collapsed below
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    // Collapse runs of blank lines left by nested tags
    let mut cleaned = String::with_capacity(out.len());
    let mut blank = true;
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            if !blank {
                cleaned.push('\n');
            }
            blank = true;
        } else {
            cleaned.push_str(t);
            cleaned.push('\n');
            blank = false;
        }
    }
    cleaned.trim().to_string()
}

fn decode_polyline(s: &str) -> Vec<[f64; 2]> {
    let bytes = s.as_bytes();
    let mut coords = Vec::new();
    let (mut lon, mut lat): (i64, i64) = (0, 0);
    let mut i = 0;
    let next_delta = |i: &mut usize| -> Option<i64> {
        let (mut shift, mut result): (u32, i64) = (0, 0);
        loop {
            let b = i64::from(*bytes.get(*i)?) - 63;
            *i += 1;
            result |= (b & 0x1f) << shift;
            shift += 5;
            if b < 0x20 {
                break;
            }
        }
        Some(if result & 1 == 1 { !(result >> 1) } else { result >> 1 })
    };
    while i < bytes.len() {
        let (Some(dlon), Some(dlat)) = (next_delta(&mut i), next_delta(&mut i)) else { break };
        lon += dlon;
        lat += dlat;
        coords.push([lon as f64 / 1e5, lat as f64 / 1e5]);
    }
    coords
}

// ---------------------------------------------------------------------------
// GET /api/closures
// ---------------------------------------------------------------------------

async fn get_closures(Extension(pool): Extension<PgPool>) -> Json<ClosuresBody> {
    let mut features: Vec<Value> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // --- SA: pass through, normalising properties ---
    match fetch_sa().await {
        Ok(fc) => {
            for f in fc.get("features").and_then(Value::as_array).into_iter().flatten() {
                let p = &f["properties"];
                let status = match p["STATUS"].as_i64().unwrap_or(0) {
                    5 => "closed",
                    3 | 4 => "4wd",
                    2 => "warning",
                    _ => continue,
                };
                features.push(serde_json::json!({
                    "type": "Feature",
                    "geometry": f["geometry"],
                    "properties": {
                        "src": "SA",
                        "id": format!("sa-{}", p["OBJECTID"].as_i64().unwrap_or(0)),
                        "name": p["ROAD_SECTION"].as_str().unwrap_or("Unnamed road"),
                        "status": status,
                        "detail": p["COMMENTS"].as_str().unwrap_or("").trim(),
                        "kind": p["DESCRIPTION"].as_str().unwrap_or(""),
                        "area": p["AREA_NAME"].as_str().unwrap_or(""),
                        "url": "https://dit.sa.gov.au/outbackroads",
                    },
                }));
            }
        }
        Err(e) => {
            warn!(error = %e, "SA closures feed failed");
            warnings.push(format!("SA outback feed unavailable: {e}"));
        }
    }

    // --- NSW/VIC: hard closures, currently active, near library tracks ---
    match fetch_victraffic().await {
        Ok(items) => match filter_victraffic(&pool, items).await {
            Ok(mut fs) => features.append(&mut fs),
            Err(e) => {
                warn!(error = %e, "VicTraffic region filter failed");
                warnings.push(format!("NSW/VIC filter failed: {e}"));
            }
        },
        Err(e) => {
            warn!(error = %e, "VicTraffic feed failed");
            warnings.push(format!("NSW/VIC feed unavailable: {e}"));
        }
    }

    Json(ClosuresBody { kind: "FeatureCollection", features, warnings })
}

fn is_active(data: &Value) -> bool {
    if data["status"].as_str().unwrap_or("Active") != "Active" {
        return false;
    }
    let now = chrono::Utc::now();
    let parse = |k: &str| {
        data[k]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&chrono::Utc))
    };
    // Unparseable/missing bounds don't hide a closure — advisory layer, so
    // err on the side of showing it
    if let Some(start) = parse("start") {
        if start > now {
            return false;
        }
    }
    if let Some(end) = parse("end") {
        if end < now {
            return false;
        }
    }
    true
}

async fn filter_victraffic(pool: &PgPool, items: Vec<Value>) -> anyhow::Result<Vec<Value>> {
    struct Candidate {
        feature: Value,
        samples: Vec<[f64; 2]>,
    }

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for data in &items {
        let impact = data["impactType"].as_str().unwrap_or("");
        if impact != "Closures" && impact != "Road Closed" {
            continue;
        }
        let source = data["source"].as_str().unwrap_or("");
        // SA records come from the DIT feed with proper road-section lines and
        // graded statuses; tow trucks aren't closures
        if source == "SA" || source == "TowAllocation" {
            continue;
        }
        // Planned roadworks closures are metro maintenance noise (Ferntree
        // Gully Rd, ring-road ramps…) — thousands of them. Condition-based
        // closures stay: seasonal track closures (the DPF feed is largely
        // Parks Victoria's winter forest-track closures), flood, fire,
        // landslip, and anything unplanned.
        if data["kind"].as_str() == Some("Planned")
            && data["eventType"].as_str() == Some("Roadworks")
        {
            continue;
        }
        if !is_active(data) {
            continue;
        }
        let id = data["id"].as_str().unwrap_or("");
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }

        let lines: Vec<Vec<[f64; 2]>> = data["geolinesSet"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(decode_polyline)
            .filter(|l| l.len() >= 2)
            .collect();
        let location = data["location"].as_array().and_then(|a| {
            Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
        });

        // Proximity samples: the anchor point plus each line's ends + middle —
        // a 300 km closure whose far end brushes the library still shows
        let mut samples: Vec<[f64; 2]> = location.into_iter().collect();
        for l in &lines {
            samples.push(l[0]);
            samples.push(l[l.len() / 2]);
            samples.push(l[l.len() - 1]);
        }
        if samples.is_empty() {
            continue;
        }

        let geometry = if !lines.is_empty() {
            serde_json::json!({ "type": "MultiLineString", "coordinates": lines })
        } else {
            serde_json::json!({ "type": "Point", "coordinates": location })
        };
        let road = data["closedRoadName"].as_str().filter(|s| !s.is_empty());
        let from_road = data["from"].as_str().filter(|s| !s.is_empty());
        let name = road.or(from_road).unwrap_or("Road closure");
        let detail = strip_html(
            &[
                data["eventDueTo"].as_str().unwrap_or(""),
                data["description"].as_str().unwrap_or(""),
            ]
            .iter()
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n"),
        );

        // The upstream often ships one record per direction (same road, same
        // text) and the DPF seasonal feed repeats tracks outright
        if !seen.insert(format!("{}|{}|{}", data["source"], name, detail)) {
            continue;
        }

        let feature = serde_json::json!({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "src": if source == "NSW" { "NSW" } else { "VIC" },
                "id": id,
                "name": name,
                "status": "closed",
                "detail": detail.trim(),
                "kind": format!("{} {}", data["kind"].as_str().unwrap_or(""), data["eventType"].as_str().unwrap_or("")).trim().to_string(),
                "updated": data["updated"],
                "url": format!("https://traffic.transport.vic.gov.au/disruptions/{id}"),
            },
        });
        candidates.push(Candidate { feature, samples });
    }

    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // One round trip: every sample point against the collected (simplified)
    // library geometry; a closure passes if ANY of its samples is near
    let (mut lons, mut lats, mut cids) = (Vec::new(), Vec::new(), Vec::new());
    for (ci, c) in candidates.iter().enumerate() {
        for s in &c.samples {
            lons.push(s[0]);
            lats.push(s[1]);
            cids.push(ci as i32);
        }
    }
    let rows = sqlx::query(
        "WITH tracks AS (
             SELECT ST_Collect(ST_Simplify(cleaned_geometry, 0.01)) AS g
             FROM rides
             WHERE cleaned_geometry IS NOT NULL AND superseded_by IS NULL
         )
         SELECT DISTINCT t.cid
         FROM unnest($1::float8[], $2::float8[], $3::int4[]) AS t(lon, lat, cid), tracks
         WHERE tracks.g IS NOT NULL
           AND ST_DWithin(ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326), tracks.g, $4)",
    )
    .bind(&lons)
    .bind(&lats)
    .bind(&cids)
    .bind(NEAR_TRACKS_DEG)
    .fetch_all(pool)
    .await?;

    let near: std::collections::HashSet<i32> =
        rows.into_iter().map(|r| r.get::<i32, _>("cid")).collect();
    Ok(candidates
        .into_iter()
        .enumerate()
        .filter(|(ci, _)| near.contains(&(*ci as i32)))
        .map(|(_, c)| c.feature)
        .collect())
}
