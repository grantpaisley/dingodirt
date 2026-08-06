//! `dingo privacy` — manage privacy zones (a suburb polygon, or a small circle
//! around home). Points inside a zone are removed when you EXPORT: offline
//! bundles, basket bundles, DingoNav bundles, and share links (each honours the
//! export dialog's "Hide privacy zones" checkbox / the CLI --no-privacy flag).
//! The Dingo app and the organized library on disk are your complete archive —
//! zones are NOT applied there.

use sqlx::{PgPool, Row};

/// Add (or replace) a circular home-privacy zone. With explicit `lat`/`lon`,
/// buffers that point; otherwise auto-detects home from the dominant
/// start/end cluster of your own recorded rides. `radius_m` default 300.
pub async fn add_home(
    pool: &PgPool,
    lat: Option<f64>,
    lon: Option<f64>,
    radius_m: f64,
    name: &str,
) -> anyhow::Result<()> {
    let (lat, lon) = match (lat, lon) {
        (Some(la), Some(lo)) => (la, lo),
        _ => {
            // Most common start OR end point (~11 m grid) among own recordings
            let row = sqlx::query(
                r#"
                WITH ep AS (
                    -- kind = 'recorded': only actual recordings reveal home;
                    -- planned routes start wherever their author drew them.
                    SELECT round(ST_Y(ST_StartPoint(cleaned_geometry))::numeric, 4) AS lat,
                           round(ST_X(ST_StartPoint(cleaned_geometry))::numeric, 4) AS lon
                    FROM rides WHERE origin = 'self' AND track_type <> 'route'
                      AND kind = 'recorded'
                      AND superseded_by IS NULL AND cleaned_geometry IS NOT NULL
                    UNION ALL
                    SELECT round(ST_Y(ST_EndPoint(cleaned_geometry))::numeric, 4),
                           round(ST_X(ST_EndPoint(cleaned_geometry))::numeric, 4)
                    FROM rides WHERE origin = 'self' AND track_type <> 'route'
                      AND kind = 'recorded'
                      AND superseded_by IS NULL AND cleaned_geometry IS NOT NULL
                )
                SELECT lat::float8 AS lat, lon::float8 AS lon, count(*) AS n FROM ep
                GROUP BY lat, lon ORDER BY n DESC LIMIT 1
                "#,
            )
            .fetch_optional(pool)
            .await?;
            let Some(row) = row else {
                anyhow::bail!("No recorded rides to detect home from — pass --lat/--lon");
            };
            let n: i64 = row.get("n");
            let la: f64 = row.get("lat");
            let lo: f64 = row.get("lon");
            println!("📍 Detected home near {la:.4}, {lo:.4} ({n} ride ends there)");
            (la, lo)
        }
    };

    // Buffer the point on the geography (metres) then back to geometry(4326).
    sqlx::query(
        r#"
        INSERT INTO privacy_zones (name, boundary)
        VALUES ($1, ST_Multi(
            ST_Buffer(ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)::geometry))
        ON CONFLICT (name) DO UPDATE SET boundary = EXCLUDED.boundary
        "#,
    )
    .bind(name)
    .bind(lat)
    .bind(lon)
    .bind(radius_m)
    .execute(pool)
    .await?;

    let touched: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM rides
         WHERE superseded_by IS NULL AND cleaned_geometry IS NOT NULL
           AND ST_Intersects(cleaned_geometry, (SELECT boundary FROM privacy_zones WHERE name = $1))",
    )
    .bind(name)
    .fetch_one(pool)
    .await?;
    println!(
        "🔒 Home zone '{name}' set: {radius_m:.0} m circle at {lat:.4}, {lon:.4}"
    );
    println!(
        "   {touched} rides pass through it — points inside the circle are removed when you EXPORT."
    );
    println!("   (The Dingo app and the organized library keep the full data.)");
    Ok(())
}

/// Fetch a place boundary from Nominatim (OSM) and store it as a zone.
/// `query` is free text ("Arcadia, New South Wales"); `name` overrides the
/// stored zone name (defaults to OSM's display name). Re-adding a name
/// replaces its boundary.
pub async fn add_place(pool: &PgPool, query: &str, name: Option<&str>) -> anyhow::Result<()> {
    let url = format!(
        "https://nominatim.openstreetmap.org/search?q={}&format=jsonv2&polygon_geojson=1&limit=1",
        urlencoding_encode(query)
    );
    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .get(&url)
        .header("User-Agent", "dingo-trail-app/0.1 (privacy zone setup)")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let Some(hit) = resp.as_array().and_then(|a| a.first()) else {
        anyhow::bail!("Nominatim found nothing for '{query}'");
    };
    let display = hit["display_name"].as_str().unwrap_or(query);
    let geojson = &hit["geojson"];
    let gtype = geojson["type"].as_str().unwrap_or("");
    if gtype != "Polygon" && gtype != "MultiPolygon" {
        anyhow::bail!(
            "'{display}' resolved to a {gtype:?}, not a polygon — try a more specific query \
             (suburbs/localities have boundaries; addresses and POIs don't)"
        );
    }

    let zone_name = name.unwrap_or(display);
    sqlx::query(
        r#"
        INSERT INTO privacy_zones (name, boundary)
        VALUES ($1, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)))
        ON CONFLICT (name) DO UPDATE SET boundary = EXCLUDED.boundary
        "#,
    )
    .bind(zone_name)
    .bind(geojson.to_string())
    .execute(pool)
    .await?;

    let row = sqlx::query(
        "SELECT ST_Area(boundary::geography) / 1e6 AS km2,
                (SELECT count(*) FROM rides
                 WHERE superseded_by IS NULL AND cleaned_geometry IS NOT NULL
                   AND ST_Intersects(cleaned_geometry, (SELECT boundary FROM privacy_zones WHERE name = $1))
                ) AS rides_touched
         FROM privacy_zones WHERE name = $1",
    )
    .bind(zone_name)
    .fetch_one(pool)
    .await?;
    println!("🔒 Zone '{zone_name}' stored ({:.1} km²)", row.get::<f64, _>("km2"));
    println!(
        "   {} live rides touch it — their exports will be trimmed",
        row.get::<i64, _>("rides_touched")
    );
    Ok(())
}

pub async fn list(pool: &PgPool) -> anyhow::Result<()> {
    let rows = sqlx::query(
        "SELECT name, ST_Area(boundary::geography) / 1e6 AS km2, created_at::date::text AS added
         FROM privacy_zones ORDER BY name",
    )
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        println!("No privacy zones. Add one: dingo privacy add-place \"Suburb, State\"");
        return Ok(());
    }
    for r in rows {
        println!(
            "🔒 {}  ({:.1} km², added {})",
            r.get::<String, _>("name"),
            r.get::<f64, _>("km2"),
            r.get::<String, _>("added"),
        );
    }
    Ok(())
}

pub async fn remove(pool: &PgPool, name: &str) -> anyhow::Result<()> {
    let res = sqlx::query("DELETE FROM privacy_zones WHERE name = $1")
        .bind(name)
        .execute(pool)
        .await?;
    if res.rows_affected() == 0 {
        anyhow::bail!("No zone named '{name}' (see `dingo privacy list`)");
    }
    println!("Removed zone '{name}'. Future exports keep the full data.");
    Ok(())
}

/// Minimal query-string escaper (no extra dependency for one URL).
fn urlencoding_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "+".to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}
