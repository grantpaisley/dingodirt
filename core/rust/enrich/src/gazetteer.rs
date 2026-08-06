//! Offline gazetteer — Australian localities (suburb + LGA + state) for
//! reverse geocoding without any network dependency.
//!
//! Data lives in `data/gazetteer-au.tsv` (GeoNames CC-BY, see file header)
//! and is loaded into the `localities` PostGIS table via
//! `dingo gazetteer load <file>`. Lookups are nearest-neighbour KNN queries
//! on the GiST index.
//!
//! Regions are not a formal AU admin level; `data/lga-regions-au.tsv` maps
//! (state, LGA) to a curated colloquial region ("Snowy Mountains",
//! "Kimberley") and is loaded via `dingo gazetteer load-regions <file>`.

use sqlx::PgPool;
use std::collections::HashMap;
use std::path::Path;
use tracing::info;

use dingo_core::{Error, Result};

/// A resolved locality: suburb plus (usually) its LGA and state.
#[derive(Debug, Clone, PartialEq)]
pub struct Locality {
    pub suburb: String,
    pub lga: Option<String>,
    pub state: Option<String>,
}

/// (state, LGA) -> region lookup. An empty-string LGA key is the state-wide
/// default (used for the ACT, which has no LGAs).
#[derive(Debug, Default)]
pub struct RegionMap {
    map: HashMap<(String, String), String>,
}

impl RegionMap {
    /// Region for a locality: exact (state, lga) match, falling back to the
    /// state-wide default row.
    pub fn region_for(&self, state: &str, lga: Option<&str>) -> Option<&str> {
        if let Some(lga) = lga {
            if let Some(r) = self.map.get(&(state.to_string(), lga.to_string())) {
                return Some(r);
            }
        }
        self.map
            .get(&(state.to_string(), String::new()))
            .map(String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// Load the (state, LGA) -> region map from the lga_regions table.
pub async fn load_region_map(pool: &PgPool) -> Result<RegionMap> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT state, lga, region FROM lga_regions",
    )
    .fetch_all(pool)
    .await?;

    Ok(RegionMap {
        map: rows.into_iter().map(|(s, l, r)| ((s, l), r)).collect(),
    })
}

/// Load a gazetteer TSV (suburb, lga, state, lat, lng — `#` comment lines
/// skipped) into the localities table. Replaces the previous contents: the
/// table is purely derived from the committed file.
pub async fn load_gazetteer(pool: &PgPool, path: &Path) -> Result<usize> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| Error::InvalidInput(format!("Cannot read gazetteer {path:?}: {e}")))?;

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM localities").execute(&mut *tx).await?;

    let mut loaded = 0usize;
    let mut batch: Vec<(String, Option<String>, Option<String>, f64, f64)> =
        Vec::with_capacity(1000);

    for line in content.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let (Some(suburb), lga, state, Some(lat), Some(lng)) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next().and_then(|s| s.parse::<f64>().ok()),
            parts.next().and_then(|s| s.parse::<f64>().ok()),
        ) else {
            continue;
        };
        let lga = lga.filter(|s| !s.is_empty()).map(str::to_string);
        let state = state.filter(|s| !s.is_empty()).map(str::to_string);
        batch.push((suburb.to_string(), lga, state, lat, lng));

        if batch.len() >= 1000 {
            loaded += insert_batch(&mut tx, &batch).await?;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        loaded += insert_batch(&mut tx, &batch).await?;
    }
    tx.commit().await?;

    info!(loaded, "Gazetteer load complete");
    Ok(loaded)
}

async fn insert_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    batch: &[(String, Option<String>, Option<String>, f64, f64)],
) -> Result<usize> {
    let suburbs: Vec<&str> = batch.iter().map(|b| b.0.as_str()).collect();
    let lgas: Vec<Option<&str>> = batch.iter().map(|b| b.1.as_deref()).collect();
    let states: Vec<Option<&str>> = batch.iter().map(|b| b.2.as_deref()).collect();
    let lats: Vec<f64> = batch.iter().map(|b| b.3).collect();
    let lngs: Vec<f64> = batch.iter().map(|b| b.4).collect();

    let result = sqlx::query(
        r#"
        INSERT INTO localities (suburb, lga, state, location)
        SELECT s, l, st, ST_SetSRID(ST_MakePoint(lng, lat), 4326)
        FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[]) AS t(s, l, st, lat, lng)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(&suburbs)
    .bind(&lgas)
    .bind(&states)
    .bind(&lats)
    .bind(&lngs)
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected() as usize)
}

/// Load an LGA->region TSV (state, lga, region — `#` comment lines skipped;
/// empty lga = state-wide default) into the lga_regions table. Replace-all,
/// same as the gazetteer.
pub async fn load_regions(pool: &PgPool, path: &Path) -> Result<usize> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| Error::InvalidInput(format!("Cannot read regions file {path:?}: {e}")))?;

    let mut rows: Vec<(String, String, String)> = Vec::new();
    for line in content.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let (Some(state), Some(lga), Some(region)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        rows.push((state.to_string(), lga.to_string(), region.trim().to_string()));
    }

    let states: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    let lgas: Vec<&str> = rows.iter().map(|r| r.1.as_str()).collect();
    let regions: Vec<&str> = rows.iter().map(|r| r.2.as_str()).collect();

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM lga_regions").execute(&mut *tx).await?;
    sqlx::query(
        r#"
        INSERT INTO lga_regions (state, lga, region)
        SELECT s, l, r FROM unnest($1::text[], $2::text[], $3::text[]) AS t(s, l, r)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(&states)
    .bind(&lgas)
    .bind(&regions)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    info!(loaded = rows.len(), "Region map load complete");
    Ok(rows.len())
}

/// Nearest locality to a point (lon/lat, WGS84). Returns None only when the
/// localities table is empty.
pub async fn nearest_locality(pool: &PgPool, lon: f64, lat: f64) -> Result<Option<Locality>> {
    let row = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        r#"
        SELECT suburb, lga, state
        FROM localities
        ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
        LIMIT 1
        "#,
    )
    .bind(lon)
    .bind(lat)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(suburb, lga, state)| Locality { suburb, lga, state }))
}

/// Count of loaded localities (0 = gazetteer not loaded yet).
pub async fn locality_count(pool: &PgPool) -> Result<i64> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM localities")
        .fetch_one(pool)
        .await?)
}
