//! Area assignment service - assigns rides to geographic areas

use sqlx::PgPool;
use tracing::{info, warn};

use crate::area::find_area_for_point;
use crate::{AreaId, Result, RideId};

/// Summary of area assignments
#[derive(Debug, Default)]
pub struct AssignmentSummary {
    pub rides_processed: usize,
    pub rides_assigned: usize,
    pub rides_no_area: usize,
    pub rides_skipped: usize,
    pub rides_failed: usize,
}

/// Ride data needed for area assignment
struct RideForAssignment {
    lat: f64,
    lon: f64,
}

/// Get rides that need area assignment
async fn get_unassigned_rides(pool: &PgPool) -> Result<Vec<RideId>> {
    let rows = sqlx::query!(
        r#"
        SELECT id FROM rides
        WHERE area_id IS NULL
          AND (cleaned_geometry IS NOT NULL OR raw_geometry IS NOT NULL)
        ORDER BY started_at DESC NULLS LAST
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| RideId::from_uuid(r.id)).collect())
}

/// Get ride start point for assignment
async fn get_ride_start_point(pool: &PgPool, ride_id: RideId) -> Result<Option<RideForAssignment>> {
    let row = sqlx::query!(
        r#"
        SELECT
            id,
            ST_X(ST_StartPoint(COALESCE(cleaned_geometry, raw_geometry))) as lon,
            ST_Y(ST_StartPoint(COALESCE(cleaned_geometry, raw_geometry))) as lat
        FROM rides
        WHERE id = $1
          AND (cleaned_geometry IS NOT NULL OR raw_geometry IS NOT NULL)
        "#,
        ride_id.0
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| RideForAssignment {
        lat: r.lat.unwrap_or(0.0),
        lon: r.lon.unwrap_or(0.0),
    }))
}

/// Assign a single ride to an area based on its start point
pub async fn assign_ride_to_area(pool: &PgPool, ride_id: RideId) -> Result<Option<AreaId>> {
    let ride = get_ride_start_point(pool, ride_id).await?;

    let Some(ride) = ride else {
        return Ok(None);
    };

    // Find the most specific area for this point
    let area = find_area_for_point(pool, ride.lat, ride.lon).await?;

    match area {
        Some(a) => {
            sqlx::query!(
                "UPDATE rides SET area_id = $2 WHERE id = $1",
                ride_id.0,
                a.id.0
            )
            .execute(pool)
            .await?;

            info!(ride_id = %ride_id, area = %a.name, "Assigned ride to area");
            Ok(Some(a.id))
        }
        None => {
            info!(ride_id = %ride_id, "No area contains ride start point");
            Ok(None)
        }
    }
}

/// Assign all unassigned rides to areas
pub async fn assign_all_rides_to_areas(pool: &PgPool) -> Result<AssignmentSummary> {
    let ride_ids = get_unassigned_rides(pool).await?;
    let mut summary = AssignmentSummary::default();

    for ride_id in ride_ids {
        summary.rides_processed += 1;

        let ride = match get_ride_start_point(pool, ride_id).await {
            Ok(Some(r)) => r,
            Ok(None) => {
                summary.rides_skipped += 1;
                continue;
            }
            Err(e) => {
                warn!(ride_id = %ride_id, error = %e, "Failed to get ride start point");
                summary.rides_failed += 1;
                continue;
            }
        };

        let area = match find_area_for_point(pool, ride.lat, ride.lon).await {
            Ok(a) => a,
            Err(e) => {
                warn!(ride_id = %ride_id, error = %e, "Failed to find area for point");
                summary.rides_failed += 1;
                continue;
            }
        };

        match area {
            Some(a) => {
                if let Err(e) = sqlx::query!(
                    "UPDATE rides SET area_id = $2 WHERE id = $1",
                    ride_id.0,
                    a.id.0
                )
                .execute(pool)
                .await
                {
                    warn!(ride_id = %ride_id, error = %e, "Failed to update ride area");
                    summary.rides_failed += 1;
                    continue;
                }

                info!(ride_id = %ride_id, area = %a.name, "Assigned ride to area");
                summary.rides_assigned += 1;
            }
            None => {
                summary.rides_no_area += 1;
            }
        }
    }

    Ok(summary)
}

/// Reassign all rides to areas (including those already assigned)
pub async fn reassign_all_rides_to_areas(pool: &PgPool) -> Result<AssignmentSummary> {
    // First clear all assignments
    sqlx::query!("UPDATE rides SET area_id = NULL")
        .execute(pool)
        .await?;

    // Then assign all
    assign_all_rides_to_areas(pool).await
}
