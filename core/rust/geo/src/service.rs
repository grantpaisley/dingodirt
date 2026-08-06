//! Cleaning service - fetches rides from DB, cleans them, updates with results

use chrono::Utc;
use sqlx::PgPool;
use tracing::{info, warn};

use dingo_core::{Error, Result, RideId};

use crate::cleaning::{CleaningConfig, TrackCleaner};
use crate::smooth::GeoPoint;

/// Result of cleaning a single ride
#[derive(Debug)]
pub struct CleanResult {
    pub ride_id: RideId,
    pub original_points: usize,
    pub cleaned_points: usize,
    pub stops_detected: usize,
    pub total_stopped_secs: i64,
}

/// Summary of cleaning multiple rides
#[derive(Debug, Default)]
pub struct CleanSummary {
    pub rides_processed: usize,
    pub rides_cleaned: usize,
    pub rides_skipped: usize,
    pub rides_failed: usize,
    pub total_points_reduced: usize,
    pub total_stops_detected: usize,
}

/// Get list of uncleaned ride IDs
pub async fn get_uncleaned_rides(pool: &PgPool) -> Result<Vec<RideId>> {
    let rows = sqlx::query!(
        r#"
        SELECT id FROM rides
        WHERE cleaned_at IS NULL AND raw_time_series IS NOT NULL
          AND kind = 'recorded'
        ORDER BY imported_at DESC
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| RideId::from_uuid(r.id)).collect())
}

/// Get a single ride by ID
pub async fn get_ride(pool: &PgPool, ride_id: RideId) -> Result<Option<RideData>> {
    let row = sqlx::query!(
        r#"
        SELECT id, name, raw_time_series, fit_sport, fit_sub_sport
        FROM rides
        WHERE id = $1
        "#,
        ride_id.0
    )
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => {
            let points = parse_time_series(r.raw_time_series)?;
            Ok(Some(RideData {
                id: RideId::from_uuid(r.id),
                name: r.name,
                points,
                fit_sport: r.fit_sport,
                fit_sub_sport: r.fit_sub_sport,
            }))
        }
        None => Ok(None),
    }
}

/// Internal representation of a ride for cleaning
pub struct RideData {
    pub id: RideId,
    pub name: Option<String>,
    pub points: Vec<GeoPoint>,
    pub fit_sport: Option<String>,
    pub fit_sub_sport: Option<String>,
}

/// Parse raw_time_series JSON into GeoPoints
fn parse_time_series(json: Option<serde_json::Value>) -> Result<Vec<GeoPoint>> {
    let Some(value) = json else {
        return Ok(vec![]);
    };

    // The raw_time_series is stored as array of TrackPoint objects
    let arr = value
        .as_array()
        .ok_or_else(|| Error::InvalidInput("raw_time_series should be an array".to_string()))?;

    let mut points = Vec::with_capacity(arr.len());
    for item in arr {
        let lat = item.get("lat").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let lon = item.get("lon").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let elevation = item.get("elevation").and_then(|v| v.as_f64());
        let time = item
            .get("time")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));
        let heart_rate = item
            .get("heart_rate")
            .and_then(|v| v.as_u64())
            .map(|v| v as u8);

        points.push(GeoPoint {
            lat,
            lon,
            elevation,
            time,
            heart_rate,
        });
    }

    Ok(points)
}

/// Clean a single ride and update the database
pub async fn clean_ride(
    pool: &PgPool,
    ride_id: RideId,
    config: &CleaningConfig,
) -> Result<CleanResult> {
    // Fetch the ride
    let ride = get_ride(pool, ride_id)
        .await?
        .ok_or_else(|| Error::NotFound(format!("Ride {ride_id} not found")))?;

    if ride.points.is_empty() {
        return Err(Error::InvalidInput("Ride has no points".to_string()));
    }

    // Clean the track
    let cleaner = TrackCleaner::new(config.clone());
    let cleaned = cleaner.clean(&ride.points);

    // Build cleaned geometry as GeoJSON
    let cleaned_geojson = build_geojson(&cleaned.simplified_points());

    // Time series (speed / distance / is_stopped) computed on the full-resolution
    // track, then reduced to the simplified points — see CleanedTrack::time_series.
    let time_series = cleaned.time_series();
    let time_series_json = serde_json::to_value(&time_series)?;

    // Serialize stops
    let stops_json = serde_json::to_value(&cleaned.stops)?;

    // Classify ride mode: FIT sport metadata first, speed signature for
    // ambiguous recordings. Never clobber a manual override (mode_source = 'user').
    let ride_stats = crate::classify::RideStats::from_time_series(&time_series);
    let mode = crate::classify::classify_mode(
        ride.fit_sport.as_deref(),
        ride.fit_sub_sport.as_deref(),
        &ride_stats,
    );

    // Persisted HR/speed stats (the ride list reads these columns instead of
    // grinding the JSONB per request). Moving = speed > 0.5 m/s, same as the
    // backfill migration.
    let mut hr_sum = 0.0f64;
    let mut hr_n = 0u32;
    let mut max_hr: Option<f64> = None;
    let mut sp_sum = 0.0f64;
    let mut sp_n = 0u32;
    let mut max_sp: Option<f64> = None;
    for p in &time_series {
        if let Some(h) = p.heart_rate {
            let h = h as f64;
            max_hr = Some(max_hr.map_or(h, |m: f64| m.max(h)));
            if p.speed_ms.is_some_and(|s| s > 0.5) {
                hr_sum += h;
                hr_n += 1;
            }
        }
        if let Some(s) = p.speed_ms {
            max_sp = Some(max_sp.map_or(s, |m: f64| m.max(s)));
            if s > 0.5 {
                sp_sum += s;
                sp_n += 1;
            }
        }
    }
    let avg_hr = (hr_n > 0).then(|| hr_sum / hr_n as f64);
    let avg_speed_kmh = (sp_n > 0).then(|| sp_sum / sp_n as f64 * 3.6);
    let max_speed_kmh = max_sp.map(|s| s * 3.6);

    sqlx::query(&format!(
        r#"
        UPDATE rides SET
            cleaned_geometry = ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)),
            cleaned_time_series = $3,
            stops = $4,
            cleaned_at = NOW(),
            avg_hr = $5,
            max_hr = $6,
            avg_speed_kmh = $7,
            max_speed_kmh = $8,
            mode = CASE WHEN mode_source = 'user' THEN mode ELSE '{mode}'::ride_mode END
        WHERE id = $1
        "#,
    ))
    .bind(ride_id.0)
    .bind(&cleaned_geojson)
    .bind(&time_series_json)
    .bind(&stops_json)
    .bind(avg_hr)
    .bind(max_hr)
    .bind(avg_speed_kmh)
    .bind(max_speed_kmh)
    .execute(pool)
    .await?;

    info!(
        ride_id = %ride_id,
        original = cleaned.stats.original_points,
        simplified = cleaned.stats.simplified_points,
        stops = cleaned.stats.stops_detected,
        mode = %mode,
        "Cleaned ride"
    );

    Ok(CleanResult {
        ride_id,
        original_points: cleaned.stats.original_points,
        cleaned_points: cleaned.stats.simplified_points,
        stops_detected: cleaned.stats.stops_detected,
        total_stopped_secs: cleaned.stats.total_stopped_secs,
    })
}

/// Summary of a mode reclassification pass
#[derive(Debug, Default)]
pub struct ReclassifySummary {
    pub rides_processed: usize,
    pub rides_changed: usize,
    pub rides_skipped_user: usize,
    pub rides_failed: usize,
    /// (mode, count) before and after, for threshold tuning
    pub before: Vec<(String, i64)>,
    pub after: Vec<(String, i64)>,
}

async fn mode_distribution(pool: &PgPool) -> Result<Vec<(String, i64)>> {
    let rows =
        sqlx::query_as::<_, (String, i64)>("SELECT mode::TEXT, count(*) FROM rides WHERE kind = 'recorded' GROUP BY 1 ORDER BY 2 DESC")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

/// Re-run mode classification over all cleaned rides (skipping user overrides)
/// and propagate the result onto existing runs.
pub async fn reclassify_all_modes(pool: &PgPool) -> Result<ReclassifySummary> {
    let mut summary = ReclassifySummary {
        before: mode_distribution(pool).await?,
        ..Default::default()
    };

    let rows = sqlx::query_as::<_, (uuid::Uuid, Option<String>, Option<String>, String, serde_json::Value)>(
        r#"
        SELECT id, fit_sport, fit_sub_sport, mode::TEXT, cleaned_time_series
        FROM rides
        -- kind filter matters here: planned routes DO carry a cleaned_time_series
        -- (elevation profile), but have no speeds to classify from and their
        -- mode is fixed at 'other'.
        WHERE cleaned_time_series IS NOT NULL AND mode_source = 'auto'
          AND kind = 'recorded'
        "#,
    )
    .fetch_all(pool)
    .await?;

    summary.rides_skipped_user = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM rides WHERE mode_source = 'user' AND kind = 'recorded'",
    )
    .fetch_one(pool)
    .await? as usize;

    for (id, fit_sport, fit_sub_sport, old_mode, ts_json) in rows {
        summary.rides_processed += 1;

        let time_series: Vec<crate::cleaning::CleanedTimeSeriesPoint> =
            match serde_json::from_value(ts_json) {
                Ok(ts) => ts,
                Err(e) => {
                    warn!(ride_id = %id, error = %e, "Bad cleaned_time_series, skipping");
                    summary.rides_failed += 1;
                    continue;
                }
            };

        let stats = crate::classify::RideStats::from_time_series(&time_series);
        let new_mode =
            crate::classify::classify_mode(fit_sport.as_deref(), fit_sub_sport.as_deref(), &stats);

        if new_mode != old_mode {
            sqlx::query(&format!(
                "UPDATE rides SET mode = '{new_mode}'::ride_mode WHERE id = $1"
            ))
            .bind(id)
            .execute(pool)
            .await?;
            summary.rides_changed += 1;
        }
    }

    // Propagate ride modes onto any existing runs (riding_mode enum shares the
    // same labels after the alignment migration).
    sqlx::query(
        r#"
        UPDATE runs SET mode = r.mode::TEXT::riding_mode
        FROM rides r
        WHERE runs.ride_id = r.id AND runs.mode::TEXT != r.mode::TEXT
        "#,
    )
    .execute(pool)
    .await?;

    summary.after = mode_distribution(pool).await?;
    Ok(summary)
}

/// Build GeoJSON LineString from points
fn build_geojson(points: &[GeoPoint]) -> String {
    let coords: Vec<String> = points
        .iter()
        .map(|p| format!("[{}, {}]", p.lon, p.lat))
        .collect();

    format!(
        r#"{{"type": "LineString", "coordinates": [{}]}}"#,
        coords.join(", ")
    )
}

/// Clean all uncleaned rides
pub async fn clean_all_rides(pool: &PgPool, config: &CleaningConfig) -> Result<CleanSummary> {
    let ride_ids = get_uncleaned_rides(pool).await?;
    let mut summary = CleanSummary::default();

    for ride_id in ride_ids {
        summary.rides_processed += 1;

        match clean_ride(pool, ride_id, config).await {
            Ok(result) => {
                summary.rides_cleaned += 1;
                summary.total_points_reduced +=
                    result.original_points.saturating_sub(result.cleaned_points);
                summary.total_stops_detected += result.stops_detected;
            }
            Err(e) => {
                warn!(ride_id = %ride_id, error = %e, "Failed to clean ride");
                summary.rides_failed += 1;
            }
        }
    }

    Ok(summary)
}
