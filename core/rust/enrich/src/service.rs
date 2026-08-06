//! Enrichment service - fetches rides, enriches with weather/solar, updates DB

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tracing::{info, warn};

use dingo_core::{Error, Result, RideId};

use crate::condition::{ConditionInference, infer_condition};
use crate::solar::{TimeOfDay, calculate_time_of_day, local_date};
use crate::weather::{DailyWeather, OpenMeteoClient};

/// Result of enriching a single ride
#[derive(Debug)]
pub struct EnrichResult {
    pub ride_id: RideId,
    pub weather: Option<DailyWeather>,
    pub time_of_day: TimeOfDay,
    pub condition: ConditionInference,
}

/// Summary of enriching multiple rides
#[derive(Debug, Default)]
pub struct EnrichSummary {
    pub rides_processed: usize,
    pub rides_enriched: usize,
    pub rides_skipped: usize,
    pub rides_failed: usize,
    pub weather_errors: usize,
}

/// Ride data needed for enrichment
struct RideForEnrichment {
    started_at: DateTime<Utc>,
    lat: f64,
    lon: f64,
}

/// Get rides that need enrichment
async fn get_unenriched_rides(pool: &PgPool) -> Result<Vec<RideId>> {
    let rows = sqlx::query!(
        r#"
        SELECT id FROM rides
        WHERE enriched_at IS NULL
          AND superseded_by IS NULL
          AND started_at IS NOT NULL
          AND (cleaned_geometry IS NOT NULL OR raw_geometry IS NOT NULL)
        ORDER BY started_at DESC
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| RideId::from_uuid(r.id)).collect())
}

/// Get ride data for enrichment
async fn get_ride_for_enrichment(
    pool: &PgPool,
    ride_id: RideId,
) -> Result<Option<RideForEnrichment>> {
    // Get the ride's start time and first point coordinates
    let row = sqlx::query!(
        r#"
        SELECT
            id,
            started_at,
            ST_X(ST_StartPoint(COALESCE(cleaned_geometry, raw_geometry))) as lon,
            ST_Y(ST_StartPoint(COALESCE(cleaned_geometry, raw_geometry))) as lat
        FROM rides
        WHERE id = $1
          AND started_at IS NOT NULL
          AND (cleaned_geometry IS NOT NULL OR raw_geometry IS NOT NULL)
        "#,
        ride_id.0
    )
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => {
            let lat = r.lat.unwrap_or(0.0);
            let lon = r.lon.unwrap_or(0.0);
            let started_at = r
                .started_at
                .ok_or_else(|| Error::InvalidInput("Ride has no start time".to_string()))?;

            Ok(Some(RideForEnrichment {
                started_at,
                lat,
                lon,
            }))
        }
        None => Ok(None),
    }
}

/// Update ride with enrichment data
async fn update_ride_enrichment(
    pool: &PgPool,
    ride_id: RideId,
    weather: Option<&DailyWeather>,
    time_of_day: &TimeOfDay,
    condition: &ConditionInference,
) -> Result<()> {
    let (precip_24h, precip_48h, temp_max, temp_min) = match weather {
        Some(w) => (w.precip_24h, w.precip_48h, w.temp_max, w.temp_min),
        None => (None, None, None, None),
    };

    // Only stamp enriched_at when weather actually came back. A failed fetch
    // still writes the (successfully computed) time_of_day, but leaves
    // enriched_at NULL so get_unenriched_rides retries the ride next pass
    // instead of permanently marking it enriched with NULL weather.
    let weather_ok = weather.is_some();

    // Use raw query to handle custom enum types
    sqlx::query(
        r#"
        UPDATE rides SET
            precip_last_24h = $2,
            precip_last_48h = $3,
            temp_max = $4,
            temp_min = $5,
            inferred_condition = $6::trail_condition,
            condition_confidence = $7::confidence_level,
            time_of_day = $8::time_of_day,
            enriched_at = CASE WHEN $9 THEN NOW() ELSE enriched_at END
        WHERE id = $1
        "#,
    )
    .bind(ride_id.0)
    .bind(precip_24h)
    .bind(precip_48h)
    .bind(temp_max)
    .bind(temp_min)
    .bind(condition.condition.as_db_str())
    .bind(condition.confidence.as_db_str())
    .bind(time_of_day.as_db_str())
    .bind(weather_ok)
    .execute(pool)
    .await?;

    Ok(())
}

/// Enrich a single ride with weather and solar data
pub async fn enrich_ride(pool: &PgPool, ride_id: RideId) -> Result<EnrichResult> {
    let ride = get_ride_for_enrichment(pool, ride_id)
        .await?
        .ok_or_else(|| {
            Error::NotFound(format!("Ride {ride_id} not found or has no geometry/time"))
        })?;

    // Calculate time of day
    let time_of_day = calculate_time_of_day(ride.lat, ride.lon, ride.started_at);

    // Fetch weather data. Open-Meteo's timezone=auto returns local-day sums, so
    // the requested date must be the ride's *local* date — the UTC date shifts
    // the window a day early for morning rides (see solar::local_date).
    let weather_client = OpenMeteoClient::new();
    let date = local_date(ride.started_at, ride.lon);

    let weather_result = weather_client
        .fetch_daily_weather(ride.lat, ride.lon, date)
        .await;

    let (weather, condition) = match weather_result {
        Ok(w) => {
            let cond = infer_condition(&w);
            (Some(w), cond)
        }
        Err(e) => {
            warn!(ride_id = %ride_id, error = %e, "Failed to fetch weather, using defaults");
            // Default to unknown condition when no weather data
            (
                None,
                ConditionInference {
                    condition: crate::condition::TrailCondition::Unknown,
                    confidence: crate::condition::ConfidenceLevel::Low,
                },
            )
        }
    };

    // Update database
    update_ride_enrichment(pool, ride_id, weather.as_ref(), &time_of_day, &condition).await?;

    info!(
        ride_id = %ride_id,
        time_of_day = ?time_of_day,
        condition = ?condition.condition,
        confidence = ?condition.confidence,
        "Enriched ride"
    );

    Ok(EnrichResult {
        ride_id,
        weather,
        time_of_day,
        condition,
    })
}

/// Enrich all unenriched rides
pub async fn enrich_all_rides(pool: &PgPool) -> Result<EnrichSummary> {
    let ride_ids = get_unenriched_rides(pool).await?;
    let mut summary = EnrichSummary::default();

    let weather_client = OpenMeteoClient::new();

    for ride_id in ride_ids {
        summary.rides_processed += 1;

        let ride = match get_ride_for_enrichment(pool, ride_id).await {
            Ok(Some(r)) => r,
            Ok(None) => {
                summary.rides_skipped += 1;
                continue;
            }
            Err(e) => {
                warn!(ride_id = %ride_id, error = %e, "Failed to fetch ride for enrichment");
                summary.rides_failed += 1;
                continue;
            }
        };

        // Calculate time of day
        let time_of_day = calculate_time_of_day(ride.lat, ride.lon, ride.started_at);

        // Fetch weather data (local date — see enrich_ride above).
        let date = local_date(ride.started_at, ride.lon);
        let weather_result = weather_client
            .fetch_daily_weather(ride.lat, ride.lon, date)
            .await;

        let (weather, condition) = match weather_result {
            Ok(w) => {
                let cond = infer_condition(&w);
                (Some(w), cond)
            }
            Err(e) => {
                warn!(ride_id = %ride_id, error = %e, "Failed to fetch weather");
                summary.weather_errors += 1;
                (
                    None,
                    ConditionInference {
                        condition: crate::condition::TrailCondition::Unknown,
                        confidence: crate::condition::ConfidenceLevel::Low,
                    },
                )
            }
        };

        // Update database
        if let Err(e) =
            update_ride_enrichment(pool, ride_id, weather.as_ref(), &time_of_day, &condition).await
        {
            warn!(ride_id = %ride_id, error = %e, "Failed to update ride enrichment");
            summary.rides_failed += 1;
            continue;
        }

        summary.rides_enriched += 1;

        info!(
            ride_id = %ride_id,
            time_of_day = ?time_of_day,
            condition = ?condition.condition,
            "Enriched ride"
        );

        // Rate limiting: small delay between requests to be nice to Open-Meteo
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    }

    Ok(summary)
}
