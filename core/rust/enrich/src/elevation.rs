//! Elevation backfill — every route and track gets elevation (2026-08-14).
//!
//! Planned routes traced in a mapping tool and some recorded rides arrive
//! with no `<ele>` at all; their profiles, slope colouring and grade cues
//! are blind. This fills the gaps from the Terrarium DEM (dem.rs):
//!
//! - `raw_time_series` points (TrackPoint shape, key `elevation`)
//! - `cleaned_time_series` points (CleanedTimeSeriesPoint shape, key `ele`)
//!
//! Only null/missing elevations are written — a GPS or barometric reading
//! that came with the file always wins over the DEM. Best-effort: a ride
//! that fails (network, decode) is skipped and counted, never poisoned.

use serde_json::Value;
use sqlx::PgPool;
use tracing::{info, warn};
use uuid::Uuid;

use dingo_core::Result;

use crate::dem::DemClient;

#[derive(Debug, Default)]
pub struct ElevationSummary {
    pub rides_processed: usize,
    pub rides_filled: usize,
    pub points_filled: usize,
    pub rides_failed: usize,
}

/// Fill missing elevations for every live ride that needs it.
pub async fn backfill_elevation(pool: &PgPool) -> Result<ElevationSummary> {
    let rows = sqlx::query!(
        r#"
        SELECT id FROM rides
        WHERE superseded_by IS NULL
          AND (
            (raw_time_series IS NOT NULL AND
             jsonb_path_exists(raw_time_series, '$[*] ? (@.elevation == null)'))
            OR
            (cleaned_time_series IS NOT NULL AND
             jsonb_path_exists(cleaned_time_series, '$[*] ? (@.ele == null)'))
          )
        ORDER BY imported_at DESC
        "#
    )
    .fetch_all(pool)
    .await?;
    let ids: Vec<Uuid> = rows.into_iter().map(|r| r.id).collect();
    backfill_elevation_for(pool, &ids).await
}

/// Fill missing elevations for specific rides (the post-import hook).
pub async fn backfill_elevation_for(pool: &PgPool, ids: &[Uuid]) -> Result<ElevationSummary> {
    let mut dem = DemClient::new();
    let mut summary = ElevationSummary::default();

    for &id in ids {
        summary.rides_processed += 1;
        match fill_one(pool, &mut dem, id).await {
            Ok(0) => {}
            Ok(n) => {
                summary.rides_filled += 1;
                summary.points_filled += n;
            }
            Err(e) => {
                summary.rides_failed += 1;
                warn!(ride_id = %id, error = %e, "elevation backfill failed");
            }
        }
    }

    if summary.rides_filled > 0 || summary.rides_failed > 0 {
        info!(
            rides = summary.rides_processed,
            filled = summary.rides_filled,
            points = summary.points_filled,
            failed = summary.rides_failed,
            "elevation backfill"
        );
    }
    Ok(summary)
}

/// Fill one ride's two series; returns how many point elevations were written.
async fn fill_one(pool: &PgPool, dem: &mut DemClient, id: Uuid) -> Result<usize> {
    let row = sqlx::query!(
        "SELECT raw_time_series, cleaned_time_series FROM rides WHERE id = $1",
        id
    )
    .fetch_one(pool)
    .await?;

    let mut filled = 0usize;
    let raw = match row.raw_time_series {
        Some(mut v) => {
            filled += fill_series(dem, &mut v, "elevation").await?;
            Some(v)
        }
        None => None,
    };
    let cleaned = match row.cleaned_time_series {
        Some(mut v) => {
            filled += fill_series(dem, &mut v, "ele").await?;
            Some(v)
        }
        None => None,
    };

    if filled > 0 {
        sqlx::query!(
            "UPDATE rides SET raw_time_series = COALESCE($2, raw_time_series),
                              cleaned_time_series = COALESCE($3, cleaned_time_series)
             WHERE id = $1",
            id,
            raw,
            cleaned
        )
        .execute(pool)
        .await?;
    }
    Ok(filled)
}

/// Fill nulls under `key` in a JSON point array; existing values are kept.
async fn fill_series(dem: &mut DemClient, series: &mut Value, key: &str) -> Result<usize> {
    let Some(points) = series.as_array_mut() else { return Ok(0) };
    let mut filled = 0usize;
    for p in points.iter_mut() {
        let missing = p.get(key).map(Value::is_null).unwrap_or(true);
        if !missing {
            continue;
        }
        let (Some(lat), Some(lon)) = (
            p.get("lat").and_then(Value::as_f64),
            p.get("lon").and_then(Value::as_f64),
        ) else {
            continue;
        };
        if let Some(h) = dem.elevation(lat, lon).await? {
            p[key] = serde_json::json!(h);
            filled += 1;
        }
    }
    Ok(filled)
}
