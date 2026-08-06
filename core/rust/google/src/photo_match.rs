//! Photo → ride matching
//!
//! A photo belongs to the ride whose recording window (±30 min slack)
//! contains its timestamp. Ties (overlapping rides) are broken by location
//! when the photo has GPS — nearest ride geometry wins — and by proximity
//! to the ride's midpoint time otherwise.
//!
//! match_method records where the photo's POSITION came from: 'gps' = EXIF
//! GPS, 'timestamp' = interpolated along the ride's cleaned time series.
//! Photos that match neither stay unlinked (match_method NULL) for manual
//! association in the UI.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::{debug, info};

use dingo_core::Result;

/// Photo-to-ride time window slack (photos just before/after recording count)
const RIDE_WINDOW_SLACK_MIN: i32 = 30;

#[derive(Debug, Default)]
pub struct PhotoMatchSummary {
    pub rides_assigned: usize,
    pub gps_matched: usize,
    pub timestamp_matched: usize,
    pub unmatched: usize,
}

pub async fn match_photos(pool: &PgPool) -> Result<PhotoMatchSummary> {
    let mut summary = PhotoMatchSummary::default();

    // 0. Re-point any photos still linked to a ride that has since been
    //    superseded (by dedupe-rides / merge-parts) onto the surviving ride.
    //    Otherwise those photos reference rides that no longer appear in any
    //    API listing. Loops to follow multi-hop supersession chains.
    repoint_superseded_photos(pool).await?;

    // 1. Assign ride_id: the time window qualifies candidate rides; the
    //    tie-break combines both signals — photos with GPS pick the ride
    //    whose track they're closest to, photos without fall back to the
    //    ride whose midpoint time is nearest.
    let assigned = sqlx::query(
        r#"
        UPDATE photos p SET ride_id = m.ride_id
        FROM (
            SELECT DISTINCT ON (ph.id) ph.id AS photo_id, r.id AS ride_id
            FROM photos ph
            JOIN rides r
              ON ph.taken_at BETWEEN r.started_at - make_interval(mins => $1)
                                 AND r.ended_at   + make_interval(mins => $1)
            WHERE ph.ride_id IS NULL
              AND ph.taken_at IS NOT NULL
              AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL
              AND r.superseded_by IS NULL
            ORDER BY ph.id,
                     -- Never compare metres against seconds. Rides we can score
                     -- by GPS distance (photo has a location AND the ride has
                     -- geometry) rank ahead of rides we can only score by time,
                     -- so the two metrics are only ever compared within a tier.
                     CASE WHEN ph.location IS NOT NULL AND r.cleaned_geometry IS NOT NULL
                          THEN 0 ELSE 1 END,
                     CASE WHEN ph.location IS NOT NULL AND r.cleaned_geometry IS NOT NULL
                          THEN ST_Distance(r.cleaned_geometry::geography,
                                           ph.location::geography)
                          ELSE ABS(EXTRACT(EPOCH FROM (ph.taken_at
                              - (r.started_at + (r.ended_at - r.started_at) / 2))))
                     END
        ) m
        WHERE p.id = m.photo_id
        "#,
    )
    .bind(RIDE_WINDOW_SLACK_MIN)
    .execute(pool)
    .await?;
    summary.rides_assigned = assigned.rows_affected() as usize;

    // 2. Photos that carry their own GPS position: the EXIF location is the
    //    position record — mark them matched by 'gps'.
    let gps = sqlx::query(
        r#"
        UPDATE photos SET match_method = 'gps'
        WHERE location IS NOT NULL AND match_method IS NULL AND ride_id IS NOT NULL
        "#,
    )
    .execute(pool)
    .await?;
    summary.gps_matched = gps.rows_affected() as usize;

    // 3. Timestamp-only photos on a ride: interpolate position along the
    //    ride's time series.
    summary.timestamp_matched = match_by_timestamp(pool).await?;

    let unmatched: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM photos WHERE match_method IS NULL AND taken_at IS NOT NULL",
    )
    .fetch_one(pool)
    .await?;
    summary.unmatched = unmatched.0 as usize;

    info!(
        rides = summary.rides_assigned,
        gps = summary.gps_matched,
        timestamp = summary.timestamp_matched,
        unmatched = summary.unmatched,
        "Photo matching complete"
    );
    Ok(summary)
}

/// Re-point photos linked to superseded rides onto the surviving ride, one
/// supersession hop per iteration until the graph is fully resolved.
async fn repoint_superseded_photos(pool: &PgPool) -> Result<usize> {
    let mut total = 0usize;
    // Bounded loop: each pass advances every photo one hop along its chain;
    // supersession is single-level in practice, so this converges immediately.
    for _ in 0..16 {
        let moved = sqlx::query(
            r#"
            UPDATE photos p SET ride_id = r.superseded_by
            FROM rides r
            WHERE p.ride_id = r.id AND r.superseded_by IS NOT NULL
            "#,
        )
        .execute(pool)
        .await?;
        let n = moved.rows_affected();
        total += n as usize;
        if n == 0 {
            break;
        }
    }
    if total > 0 {
        info!(repointed = total, "Re-pointed photos off superseded rides");
    }
    Ok(total)
}

/// Interpolate each unlocated on-ride photo's position from the ride's
/// cleaned time series and store it.
async fn match_by_timestamp(pool: &PgPool) -> Result<usize> {
    let photos = sqlx::query(
        r#"
        SELECT p.id, p.ride_id, p.taken_at
        FROM photos p
        WHERE p.location IS NULL
          AND p.match_method IS NULL
          AND p.ride_id IS NOT NULL
          AND p.taken_at IS NOT NULL
        ORDER BY p.ride_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut matched = 0usize;
    let mut current_ride: Option<uuid::Uuid> = None;
    let mut track: Vec<(i64, f64, f64)> = Vec::new(); // (epoch, lat, lon)

    for row in photos {
        let photo_id: uuid::Uuid = row.get("id");
        let ride_id: uuid::Uuid = row.get("ride_id");
        let taken_at: DateTime<Utc> = row.get("taken_at");

        if current_ride != Some(ride_id) {
            track = load_track(pool, ride_id).await?;
            current_ride = Some(ride_id);
        }
        let Some((lat, lon)) = interpolate_position(&track, taken_at.timestamp()) else {
            continue;
        };

        let result = sqlx::query(
            r#"
            UPDATE photos SET
                location = ST_SetSRID(ST_MakePoint($2, $1), 4326),
                match_method = 'timestamp'
            WHERE id = $3
            "#,
        )
        .bind(lat)
        .bind(lon)
        .bind(photo_id)
        .execute(pool)
        .await?;

        if result.rows_affected() > 0 {
            matched += 1;
        }
    }

    Ok(matched)
}

/// Load (epoch, lat, lon) triples from a ride's cleaned time series
async fn load_track(pool: &PgPool, ride_id: uuid::Uuid) -> Result<Vec<(i64, f64, f64)>> {
    let row = sqlx::query("SELECT cleaned_time_series FROM rides WHERE id = $1")
        .bind(ride_id)
        .fetch_optional(pool)
        .await?;

    let Some(row) = row else {
        return Ok(Vec::new());
    };
    let ts_json: Option<serde_json::Value> = row.get("cleaned_time_series");
    let Some(arr) = ts_json.and_then(|v| v.as_array().cloned()) else {
        return Ok(Vec::new());
    };

    let mut track: Vec<(i64, f64, f64)> = arr
        .iter()
        .filter_map(|item| {
            let epoch = item
                .get("time")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp())?;
            let lat = item.get("lat").and_then(|v| v.as_f64())?;
            let lon = item.get("lon").and_then(|v| v.as_f64())?;
            Some((epoch, lat, lon))
        })
        .collect();
    track.sort_by_key(|(t, _, _)| *t);

    debug!(ride_id = %ride_id, points = track.len(), "Loaded track for photo interpolation");
    Ok(track)
}

/// Linear interpolation along the track; clamps to the ends when the photo
/// falls in the ±30 min slack outside the recording.
fn interpolate_position(track: &[(i64, f64, f64)], at: i64) -> Option<(f64, f64)> {
    let first = track.first()?;
    let last = track.last()?;
    if at <= first.0 {
        return Some((first.1, first.2));
    }
    if at >= last.0 {
        return Some((last.1, last.2));
    }

    let idx = track.partition_point(|(t, _, _)| *t <= at);
    let (t0, lat0, lon0) = track[idx - 1];
    let (t1, lat1, lon1) = track[idx];
    if t1 == t0 {
        return Some((lat0, lon0));
    }
    let f = (at - t0) as f64 / (t1 - t0) as f64;
    Some((lat0 + (lat1 - lat0) * f, lon0 + (lon1 - lon0) * f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_midpoint_and_clamping() {
        let track = vec![(100, -33.0, 151.0), (200, -34.0, 152.0)];
        assert_eq!(interpolate_position(&track, 150), Some((-33.5, 151.5)));
        assert_eq!(interpolate_position(&track, 50), Some((-33.0, 151.0)));
        assert_eq!(interpolate_position(&track, 300), Some((-34.0, 152.0)));
        assert_eq!(interpolate_position(&[], 100), None);
    }
}
