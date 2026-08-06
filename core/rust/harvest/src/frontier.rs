//! Frontier persistence — the harvester's memory. Regions name the targets;
//! `harvest_frontier` rows record every tile ever considered so a month-long
//! run survives restarts, and the estimator (phase 3) can count what exists.

use anyhow::{Context, Result};
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use uuid::Uuid;

use crate::tiles;

/// A named harvest target: bbox + zoom range.
#[derive(Debug, Clone)]
pub struct Region {
    pub id: Uuid,
    pub name: String,
    /// `[west, south, east, north]`
    pub bbox: [f64; 4],
    pub seed_zoom: u32,
    pub target_zoom: u32,
}

/// The synthetic owner harvested Strava heat hangs off (seeded by the owners
/// migration).
pub async fn strava_owner(pool: &PgPool) -> Result<Uuid> {
    sqlx::query_scalar!(
        r#"SELECT id FROM owners WHERE kind = 'synthetic' AND name = 'Strava global'"#
    )
    .fetch_optional(pool)
    .await?
    .context("no 'Strava global' owner — run the daemon once to apply migrations")
}

/// Create a region and seed its frontier: the region's tile cover at
/// `seed_zoom`, all `pending`. Returns (region, seeded tile count).
pub async fn add_region(
    pool: &PgPool,
    owner_id: Uuid,
    name: &str,
    bbox: [f64; 4],
    seed_zoom: u32,
    target_zoom: u32,
) -> Result<(Region, u64)> {
    let [w, s, e, n] = bbox;
    anyhow::ensure!(w < e && s < n, "bbox must be west,south,east,north with west<east, south<north");
    let id = sqlx::query_scalar!(
        r#"
        INSERT INTO harvest_regions (name, geom, seed_zoom, target_zoom)
        VALUES ($1, ST_MakeEnvelope($2, $3, $4, $5, 4326), $6, $7)
        RETURNING id
        "#,
        name,
        w,
        s,
        e,
        n,
        seed_zoom as i32,
        target_zoom as i32,
    )
    .fetch_one(pool)
    .await
    .context("insert region (name taken?)")?;

    let region = Region { id, name: name.to_string(), bbox, seed_zoom, target_zoom };
    let seeded = seed(pool, owner_id, &region).await?;
    Ok((region, seeded))
}

/// Create a *corridor* region and seed it with the exact tiles the user's own
/// tracks cross (within `bbox`) at zoom `zmax`, dilated by `ring` tiles, plus
/// every parent tile down to `zmin`. `target_zoom` is set to `zmin` so the
/// worker never descends — only these seeded corridor tiles are ever fetched,
/// keeping the z15 harvest tight to where you actually ride.
pub async fn add_corridor_region(
    pool: &PgPool,
    owner_id: Uuid,
    name: &str,
    bbox: [f64; 4],
    zmin: u32,
    zmax: u32,
    ring: u32,
    segmentize_deg: f64,
) -> Result<(Region, u64)> {
    let [w, s, e, n] = bbox;
    anyhow::ensure!(w < e && s < n, "bbox must be west,south,east,north");
    anyhow::ensure!(zmin <= zmax, "zmin must be <= zmax");

    // The distinct zmax tiles the tracks pass through, computed in-DB. Tracks are
    // segmentized first so a long straight segment can't skip over a tile.
    let nmax = (1u64 << zmax) as f64;
    let rows = sqlx::query(
        r#"
        WITH lines AS (
            SELECT ST_Segmentize(cleaned_geometry, $5) AS g
            FROM rides
            WHERE cleaned_geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)
              AND kind = 'recorded'
        ),
        pts AS (SELECT (ST_DumpPoints(g)).geom AS p FROM lines),
        clip AS (
            SELECT p FROM pts
            WHERE ST_X(p) BETWEEN $1 AND $3 AND ST_Y(p) BETWEEN $2 AND $4
        )
        SELECT DISTINCT
            floor((ST_X(p) + 180.0) / 360.0 * $6)::int AS x,
            floor((1 - ln(tan(radians(ST_Y(p))) + 1 / cos(radians(ST_Y(p)))) / pi()) / 2 * $6)::int AS y
        FROM clip
        "#,
    )
    .bind(w)
    .bind(s)
    .bind(e)
    .bind(n)
    .bind(segmentize_deg)
    .bind(nmax)
    .fetch_all(pool)
    .await
    .context("compute corridor tiles from rides")?;

    let coords = fold_corridor(&rows, zmin, zmax, ring);

    // target_zoom = zmin means no seeded tile (all >= zmin) is ever descended.
    let id = sqlx::query_scalar!(
        r#"
        INSERT INTO harvest_regions (name, geom, seed_zoom, target_zoom)
        VALUES ($1, ST_MakeEnvelope($2, $3, $4, $5, 4326), $6, $7)
        RETURNING id
        "#,
        name,
        w,
        s,
        e,
        n,
        zmin as i32,
        zmin as i32,
    )
    .fetch_one(pool)
    .await
    .context("insert corridor region (name taken?)")?;

    let region = Region { id, name: name.to_string(), bbox, seed_zoom: zmin, target_zoom: zmin };
    let seeded = enqueue(pool, owner_id, region.id, &coords).await?;
    Ok((region, seeded))
}

/// Dilate the raw `zmax` (x,y) tiles by `ring` and fold up to every parent zoom
/// down to `zmin`, yielding the full (z,x,y) seed list shared by both corridor
/// paths (bbox-region and imported-rides).
fn fold_corridor(rows: &[sqlx::postgres::PgRow], zmin: u32, zmax: u32, ring: u32) -> Vec<(u32, u32, u32)> {
    let max_idx = (1i64 << zmax) - 1;
    let r = ring as i64;
    let mut cur: HashSet<(u32, u32)> = HashSet::new();
    for row in rows {
        let x: i32 = row.get("x");
        let y: i32 = row.get("y");
        for dx in -r..=r {
            for dy in -r..=r {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if nx < 0 || ny < 0 || nx > max_idx || ny > max_idx {
                    continue;
                }
                cur.insert((nx as u32, ny as u32));
            }
        }
    }
    let mut coords: Vec<(u32, u32, u32)> = Vec::new();
    let mut z = zmax;
    loop {
        for &(x, y) in &cur {
            coords.push((z, x, y));
        }
        if z == zmin {
            break;
        }
        cur = cur.iter().map(|&(x, y)| (x / 2, y / 2)).collect();
        z -= 1;
    }
    coords
}

/// Fetch a corridor region by name, creating it if absent. Corridor regions
/// never descend (target_zoom = seed_zoom = zmin), so the geometry is a cosmetic
/// world envelope — only the seeded tiles are ever fetched.
pub async fn get_or_create_corridor_region(pool: &PgPool, name: &str, zmin: u32) -> Result<Region> {
    sqlx::query!(
        r#"
        INSERT INTO harvest_regions (name, geom, seed_zoom, target_zoom)
        VALUES ($1, ST_MakeEnvelope(-180, -85, 180, 85, 4326), $2, $2)
        ON CONFLICT (name) DO NOTHING
        "#,
        name,
        zmin as i32,
    )
    .execute(pool)
    .await
    .context("ensure corridor region")?;
    get_region(pool, name).await
}

/// Enqueue the z14/z15 corridor for a specific set of rides into the (get-or-
/// created) named corridor region. Returns (region, newly-enqueued count).
/// Used by the daemon to auto-harvest heat along freshly-imported tracks.
pub async fn seed_rides_corridor(
    pool: &PgPool,
    owner_id: Uuid,
    region_name: &str,
    ride_ids: &[Uuid],
    zmin: u32,
    zmax: u32,
    ring: u32,
    segmentize_deg: f64,
) -> Result<(Region, u64)> {
    anyhow::ensure!(zmin <= zmax, "zmin must be <= zmax");
    let region = get_or_create_corridor_region(pool, region_name, zmin).await?;
    if ride_ids.is_empty() {
        return Ok((region, 0));
    }
    let nmax = (1u64 << zmax) as f64;
    let rows = sqlx::query(
        r#"
        WITH lines AS (
            SELECT ST_Segmentize(cleaned_geometry, $2) AS g
            FROM rides
            WHERE id = ANY($1) AND cleaned_geometry IS NOT NULL
        ),
        pts AS (SELECT (ST_DumpPoints(g)).geom AS p FROM lines)
        SELECT DISTINCT
            floor((ST_X(p) + 180.0) / 360.0 * $3)::int AS x,
            floor((1 - ln(tan(radians(ST_Y(p))) + 1 / cos(radians(ST_Y(p)))) / pi()) / 2 * $3)::int AS y
        FROM pts
        "#,
    )
    .bind(ride_ids)
    .bind(segmentize_deg)
    .bind(nmax)
    .fetch_all(pool)
    .await
    .context("compute import corridor tiles from rides")?;

    let coords = fold_corridor(&rows, zmin, zmax, ring);
    let seeded = enqueue(pool, owner_id, region.id, &coords).await?;
    Ok((region, seeded))
}

/// (Re-)seed a region's frontier at its seed zoom. Idempotent: existing rows
/// (any state) are left untouched.
pub async fn seed(pool: &PgPool, owner_id: Uuid, region: &Region) -> Result<u64> {
    let cover = tiles::cover_bbox(region.bbox, region.seed_zoom);
    enqueue(pool, owner_id, region.id, &cover).await
}

/// Enqueue tiles as pending, skipping any already known.
pub async fn enqueue(
    pool: &PgPool,
    owner_id: Uuid,
    region_id: Uuid,
    coords: &[(u32, u32, u32)],
) -> Result<u64> {
    if coords.is_empty() {
        return Ok(0);
    }
    let z: Vec<i32> = coords.iter().map(|c| c.0 as i32).collect();
    let x: Vec<i32> = coords.iter().map(|c| c.1 as i32).collect();
    let y: Vec<i32> = coords.iter().map(|c| c.2 as i32).collect();
    let res = sqlx::query!(
        r#"
        INSERT INTO harvest_frontier (owner_id, region_id, z, x, y)
        SELECT $1, $2, t.z, t.x, t.y
        FROM UNNEST($3::int[], $4::int[], $5::int[]) AS t(z, x, y)
        ON CONFLICT DO NOTHING
        "#,
        owner_id,
        region_id,
        &z,
        &x,
        &y,
    )
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

pub async fn get_region(pool: &PgPool, name: &str) -> Result<Region> {
    let row = sqlx::query!(
        r#"
        SELECT id, name, seed_zoom, target_zoom,
               ST_XMin(geom) AS "west!", ST_YMin(geom) AS "south!",
               ST_XMax(geom) AS "east!", ST_YMax(geom) AS "north!"
        FROM harvest_regions WHERE name = $1
        "#,
        name,
    )
    .fetch_optional(pool)
    .await?
    .with_context(|| format!("no harvest region named {name:?} (dingo-harvest region list)"))?;
    Ok(Region {
        id: row.id,
        name: row.name,
        bbox: [row.west, row.south, row.east, row.north],
        seed_zoom: row.seed_zoom as u32,
        target_zoom: row.target_zoom as u32,
    })
}

pub async fn list_regions(pool: &PgPool) -> Result<Vec<Region>> {
    let rows = sqlx::query!(
        r#"
        SELECT id, name, seed_zoom, target_zoom,
               ST_XMin(geom) AS "west!", ST_YMin(geom) AS "south!",
               ST_XMax(geom) AS "east!", ST_YMax(geom) AS "north!"
        FROM harvest_regions ORDER BY created_at
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| Region {
            id: row.id,
            name: row.name,
            bbox: [row.west, row.south, row.east, row.north],
            seed_zoom: row.seed_zoom as u32,
            target_zoom: row.target_zoom as u32,
        })
        .collect())
}

/// Next tile to fetch: breadth-first (shallowest zoom first), so parents are
/// always resolved before their children exist.
pub async fn next_pending(
    pool: &PgPool,
    owner_id: Uuid,
    region_id: Uuid,
) -> Result<Option<(u32, u32, u32, i32)>> {
    let row = sqlx::query!(
        r#"
        SELECT z, x, y, attempts FROM harvest_frontier
        WHERE owner_id = $1 AND region_id = $2 AND state = 'pending'
        ORDER BY z, x, y
        LIMIT 1
        "#,
        owner_id,
        region_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.z as u32, r.x as u32, r.y as u32, r.attempts)))
}

/// Resolve a tile to a terminal state, recording its measured heat.
pub async fn mark(
    pool: &PgPool,
    owner_id: Uuid,
    region_id: Uuid,
    (z, x, y): (u32, u32, u32),
    state: &str,
    heat_ratio: Option<f64>,
) -> Result<()> {
    sqlx::query!(
        r#"
        UPDATE harvest_frontier
        SET state = $6, heat_ratio = $7, fetched_at = now(), attempts = attempts + 1
        WHERE owner_id = $1 AND region_id = $2 AND z = $3 AND x = $4 AND y = $5
        "#,
        owner_id,
        region_id,
        z as i32,
        x as i32,
        y as i32,
        state,
        heat_ratio.map(|r| r as f32),
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Record a failed attempt, leaving the tile pending. Returns the new count.
pub async fn bump_attempts(
    pool: &PgPool,
    owner_id: Uuid,
    region_id: Uuid,
    (z, x, y): (u32, u32, u32),
) -> Result<i32> {
    let attempts = sqlx::query_scalar!(
        r#"
        UPDATE harvest_frontier SET attempts = attempts + 1
        WHERE owner_id = $1 AND region_id = $2 AND z = $3 AND x = $4 AND y = $5
        RETURNING attempts
        "#,
        owner_id,
        region_id,
        z as i32,
        x as i32,
        y as i32,
    )
    .fetch_one(pool)
    .await?;
    Ok(attempts)
}

/// Put `failed` tiles back in the queue (e.g. after an outage cleared).
pub async fn requeue_failed(pool: &PgPool, owner_id: Uuid, region_id: Uuid) -> Result<u64> {
    let res = sqlx::query!(
        r#"
        UPDATE harvest_frontier SET state = 'pending', attempts = 0
        WHERE owner_id = $1 AND region_id = $2 AND state = 'failed'
        "#,
        owner_id,
        region_id,
    )
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

#[derive(Debug)]
pub struct StateCount {
    pub z: i32,
    pub state: String,
    pub count: i64,
}

pub async fn status(pool: &PgPool, owner_id: Uuid, region_id: Uuid) -> Result<Vec<StateCount>> {
    let rows = sqlx::query!(
        r#"
        SELECT z, state, count(*) AS "count!"
        FROM harvest_frontier
        WHERE owner_id = $1 AND region_id = $2
        GROUP BY z, state
        ORDER BY z, state
        "#,
        owner_id,
        region_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| StateCount { z: r.z, state: r.state, count: r.count })
        .collect())
}

pub async fn pending_count(pool: &PgPool, owner_id: Uuid, region_id: Uuid) -> Result<i64> {
    Ok(sqlx::query_scalar!(
        r#"
        SELECT count(*) AS "count!" FROM harvest_frontier
        WHERE owner_id = $1 AND region_id = $2 AND state = 'pending'
        "#,
        owner_id,
        region_id,
    )
    .fetch_one(pool)
    .await?)
}
