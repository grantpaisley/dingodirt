//! Turn-cue detection — shared junction marks from named-road transitions.
//!
//! Design: Docs/plans/2026-08-03-gmaps-import-turn-cues-design.md. The track
//! is resampled to ~15 m, each sample matched to the nearest named road
//! (roads table, ≤ 25 m), the name sequence run-length smoothed, and each
//! boundary between two different sustained roads becomes a turn. Marks are
//! junction-level and shared: one `turn_marks` row per corner (normalized
//! road pair), with the per-ride manoeuvre (dir/from/onto/dist) on the
//! `ride_turn_marks` link. A ride that sails straight through a junction on
//! the same named road gets no link — the cue "fires only if needed".

use sqlx::PgPool;
use sqlx::Row;
use tracing::{info, warn};
use uuid::Uuid;

use dingo_core::{Error, Result, RideId};

use crate::smooth::haversine_distance;

/// Spacing of resampled points along the track.
const SAMPLE_SPACING_M: f64 = 15.0;
/// A sample only matches a road within this distance.
const MATCH_RADIUS_M: f64 = 25.0;
/// A road must hold for this many consecutive samples (~45 m) to count —
/// kills flicker from crossings, overpasses and parallel service roads.
const MIN_RUN_SAMPLES: usize = 3;
/// Unmatched gap allowed between two named runs while still cueing the
/// transition (roundabouts, wide intersections): ~150 m.
const MAX_GAP_SAMPLES: usize = 10;
/// Bearing change at or above this is a L/R turn; below is S ("continue").
const TURN_ANGLE_DEG: f64 = 25.0;
/// Junction sharing radius: an existing mark within this distance with the
/// same road pair is reused rather than duplicated.
const MARK_MATCH_RADIUS_M: f64 = 30.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnDir {
    Left,
    Right,
    Straight,
}

impl TurnDir {
    pub fn as_str(&self) -> &'static str {
        match self {
            TurnDir::Left => "L",
            TurnDir::Right => "R",
            TurnDir::Straight => "S",
        }
    }
}

/// A resampled track point with its matched road (if any).
#[derive(Debug, Clone)]
pub struct RoadSample {
    pub lon: f64,
    pub lat: f64,
    pub dist_m: f64,
    pub road: Option<String>,
}

/// A detected named-road transition on one track.
#[derive(Debug, Clone)]
pub struct TurnEvent {
    pub lon: f64,
    pub lat: f64,
    pub dir: TurnDir,
    pub from_road: String,
    pub onto_road: String,
    pub dist_m: f64,
}

/// Resample a polyline to ~15 m spacing (linear interpolation along
/// segments — Google-polyline plans only carry vertices at bends, so
/// sampling raw vertices would starve long straights).
pub fn resample(points: &[(f64, f64)]) -> Vec<(f64, f64, f64)> {
    let mut out: Vec<(f64, f64, f64)> = Vec::new();
    let Some(&(lon0, lat0)) = points.first() else {
        return out;
    };
    out.push((lon0, lat0, 0.0));
    let mut travelled = 0.0; // total distance at previous vertex
    let mut next_at = SAMPLE_SPACING_M;
    for w in points.windows(2) {
        let (alon, alat) = w[0];
        let (blon, blat) = w[1];
        let seg = haversine_distance(alat, alon, blat, blon);
        if seg <= 0.0 {
            continue;
        }
        while next_at <= travelled + seg {
            let f = (next_at - travelled) / seg;
            out.push((
                alon + (blon - alon) * f,
                alat + (blat - alat) * f,
                next_at,
            ));
            next_at += SAMPLE_SPACING_M;
        }
        travelled += seg;
    }
    out
}

fn bearing_deg(from: (f64, f64), to: (f64, f64)) -> f64 {
    let (lon1, lat1) = (from.0.to_radians(), from.1.to_radians());
    let (lon2, lat2) = (to.0.to_radians(), to.1.to_radians());
    let dlon = lon2 - lon1;
    let y = dlon.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();
    y.atan2(x).to_degrees()
}

/// Signed bearing change (degrees, positive = right/clockwise) at sample
/// `i`, measured over ~2 samples either side.
fn bearing_delta(samples: &[RoadSample], i: usize) -> f64 {
    let w = 2usize;
    let a = i.saturating_sub(w);
    let b = (i + w).min(samples.len() - 1);
    if a == i || b == i {
        return 0.0;
    }
    let before = bearing_deg(
        (samples[a].lon, samples[a].lat),
        (samples[i].lon, samples[i].lat),
    );
    let after = bearing_deg(
        (samples[i].lon, samples[i].lat),
        (samples[b].lon, samples[b].lat),
    );
    let mut d = after - before;
    while d > 180.0 {
        d -= 360.0;
    }
    while d < -180.0 {
        d += 360.0;
    }
    d
}

/// Detect named-road transitions in a matched sample sequence.
pub fn detect_turns(samples: &[RoadSample]) -> Vec<TurnEvent> {
    // Run-length compress, demoting sub-MIN_RUN named runs to noise.
    struct Run {
        road: Option<String>,
        start: usize,
        len: usize,
    }
    let mut runs: Vec<Run> = Vec::new();
    for (i, s) in samples.iter().enumerate() {
        match runs.last_mut() {
            Some(r) if r.road == s.road => r.len += 1,
            _ => runs.push(Run {
                road: s.road.clone(),
                start: i,
                len: 1,
            }),
        }
    }
    for r in &mut runs {
        if r.road.is_some() && r.len < MIN_RUN_SAMPLES {
            r.road = None;
        }
    }

    // Walk sustained named runs; a gap (None samples) of at most
    // MAX_GAP_SAMPLES between two different roads still cues.
    let mut events = Vec::new();
    let mut prev: Option<&Run> = None;
    for run in runs.iter().filter(|r| r.road.is_some()) {
        if let Some(p) = prev {
            let gap = run.start - (p.start + p.len);
            let (from, onto) = (p.road.as_ref().unwrap(), run.road.as_ref().unwrap());
            if from != onto && gap <= MAX_GAP_SAMPLES {
                let i = run.start;
                let d = bearing_delta(samples, i);
                let dir = if d.abs() < TURN_ANGLE_DEG {
                    TurnDir::Straight
                } else if d > 0.0 {
                    TurnDir::Right
                } else {
                    TurnDir::Left
                };
                events.push(TurnEvent {
                    lon: samples[i].lon,
                    lat: samples[i].lat,
                    dir,
                    from_road: from.clone(),
                    onto_road: onto.clone(),
                    dist_m: samples[i].dist_m,
                });
            }
        }
        prev = Some(run);
    }
    events
}

/// True when the roads table has been loaded — turn enrichment is skipped
/// (with a warning) until `dingo gazetteer load-roads` has run.
pub async fn roads_available(pool: &PgPool) -> Result<bool> {
    let row: (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM roads)")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

/// Match resampled points to their nearest named road (≤ 25 m). One round
/// trip: unnest the sample arrays, KNN 3 candidates by geometry (index-
/// assisted), pick the closest by exact geography distance. The KNN-then-
/// exact-filter shape avoids the geography-cast index bypass.
async fn match_roads(
    pool: &PgPool,
    resampled: &[(f64, f64, f64)],
) -> Result<Vec<RoadSample>> {
    let lons: Vec<f64> = resampled.iter().map(|p| p.0).collect();
    let lats: Vec<f64> = resampled.iter().map(|p| p.1).collect();

    let rows = sqlx::query(
        r#"
        SELECT cand.name
        FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lon, lat, idx)
        LEFT JOIN LATERAL (
            SELECT k.name
            FROM (
                SELECT name, geom
                FROM roads
                ORDER BY geom <-> ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)
                LIMIT 3
            ) k
            WHERE ST_Distance(
                k.geom::geography,
                ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography
            ) <= $3
            ORDER BY ST_Distance(
                k.geom::geography,
                ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography
            )
            LIMIT 1
        ) cand ON true
        ORDER BY t.idx
        "#,
    )
    .bind(&lons)
    .bind(&lats)
    .bind(MATCH_RADIUS_M)
    .fetch_all(pool)
    .await?;

    if rows.len() != resampled.len() {
        return Err(Error::InvalidInput(format!(
            "road match returned {} rows for {} samples",
            rows.len(),
            resampled.len()
        )));
    }

    Ok(resampled
        .iter()
        .zip(rows)
        .map(|(&(lon, lat, dist_m), row)| RoadSample {
            lon,
            lat,
            dist_m,
            road: row.get::<Option<String>, _>("name"),
        })
        .collect())
}

#[derive(Debug, Default)]
pub struct TurnSummary {
    pub cues: usize,
    pub marks_created: usize,
}

/// Recompute one ride's turn cues: drop its links, re-detect, re-link
/// (reusing shared junction marks), GC orphaned active marks. Rejected
/// marks are kept forever and matched first, so a pruned junction stays
/// pruned — its links are still written but flagged rejected at read time
/// by consumers filtering on turn_marks.status.
pub async fn recompute_ride_turns(pool: &PgPool, ride_id: RideId) -> Result<TurnSummary> {
    let row = sqlx::query(
        r#"
        SELECT ST_AsGeoJSON(COALESCE(cleaned_geometry, raw_geometry)) AS geojson
        FROM rides WHERE id = $1
        "#,
    )
    .bind(ride_id.0)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Err(Error::NotFound(format!("ride {}", ride_id.0)));
    };
    let Some(geojson) = row.get::<Option<String>, _>("geojson") else {
        // No geometry at all (failed ingest) — nothing to do.
        return Ok(TurnSummary::default());
    };

    let parsed: serde_json::Value = serde_json::from_str(&geojson)
        .map_err(|e| Error::InvalidInput(format!("bad ride geometry geojson: {e}")))?;
    let points: Vec<(f64, f64)> = parsed["coordinates"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    Some((c.get(0)?.as_f64()?, c.get(1)?.as_f64()?))
                })
                .collect()
        })
        .unwrap_or_default();
    if points.len() < 2 {
        return Ok(TurnSummary::default());
    }

    let resampled = resample(&points);
    let samples = match_roads(pool, &resampled).await?;
    let events = detect_turns(&samples);

    let mut summary = TurnSummary {
        cues: events.len(),
        marks_created: 0,
    };

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM ride_turn_marks WHERE ride_id = $1")
        .bind(ride_id.0)
        .execute(&mut *tx)
        .await?;

    for ev in &events {
        let (road_a, road_b) = if ev.from_road <= ev.onto_road {
            (&ev.from_road, &ev.onto_road)
        } else {
            (&ev.onto_road, &ev.from_road)
        };

        // Nearest existing mark for this junction (any status — rejected
        // marks keep absorbing new links so the rejection sticks).
        let existing = sqlx::query(
            r#"
            SELECT k.id
            FROM (
                SELECT id, location, road_a, road_b
                FROM turn_marks
                ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
                LIMIT 5
            ) k
            WHERE k.road_a = $3 AND k.road_b = $4
              AND ST_Distance(
                  k.location::geography,
                  ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
              ) <= $5
            LIMIT 1
            "#,
        )
        .bind(ev.lon)
        .bind(ev.lat)
        .bind(road_a)
        .bind(road_b)
        .bind(MARK_MATCH_RADIUS_M)
        .fetch_optional(&mut *tx)
        .await?;

        let mark_id: Uuid = match existing {
            Some(row) => row.get("id"),
            None => {
                summary.marks_created += 1;
                let row = sqlx::query(
                    r#"
                    INSERT INTO turn_marks (location, road_a, road_b)
                    VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, $4)
                    RETURNING id
                    "#,
                )
                .bind(ev.lon)
                .bind(ev.lat)
                .bind(road_a)
                .bind(road_b)
                .fetch_one(&mut *tx)
                .await?;
                row.get("id")
            }
        };

        sqlx::query(
            r#"
            INSERT INTO ride_turn_marks (ride_id, mark_id, dir, from_road, onto_road, dist_m)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(ride_id.0)
        .bind(mark_id)
        .bind(ev.dir.as_str())
        .bind(&ev.from_road)
        .bind(&ev.onto_road)
        .bind(ev.dist_m)
        .execute(&mut *tx)
        .await?;
    }

    // GC junctions no track links any more — rejected ones are kept so the
    // rejection outlives its last link.
    sqlx::query(
        r#"
        DELETE FROM turn_marks m
        WHERE m.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM ride_turn_marks l WHERE l.mark_id = m.id)
        "#,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(summary)
}

/// Enrich one ride if the roads table is loaded; logs and skips otherwise.
/// The import pipeline calls this so imports never fail on a missing roads
/// load.
pub async fn enrich_ride_turns(pool: &PgPool, ride_id: RideId) -> Result<TurnSummary> {
    if !roads_available(pool).await? {
        warn!("roads table empty — skipping turn cues (run: dingo gazetteer load-roads)");
        return Ok(TurnSummary::default());
    }
    let summary = recompute_ride_turns(pool, ride_id).await?;
    info!(
        ride = %ride_id.0,
        cues = summary.cues,
        new_marks = summary.marks_created,
        "turn cues computed"
    );
    Ok(summary)
}

/// Turn-cue enrichment for a batch of freshly imported rides. Checks the
/// roads table once; per-ride failures are logged and skipped so one bad
/// geometry never fails an import batch.
pub async fn enrich_rides_turns(pool: &PgPool, ride_ids: &[Uuid]) -> Result<TurnSummary> {
    if ride_ids.is_empty() {
        return Ok(TurnSummary::default());
    }
    if !roads_available(pool).await? {
        warn!("roads table empty — skipping turn cues (run: dingo gazetteer load-roads)");
        return Ok(TurnSummary::default());
    }
    let mut total = TurnSummary::default();
    for id in ride_ids {
        match recompute_ride_turns(pool, RideId::from_uuid(*id)).await {
            Ok(s) => {
                total.cues += s.cues;
                total.marks_created += s.marks_created;
            }
            Err(e) => warn!(ride = %id, error = %e, "turn-cue enrichment failed"),
        }
    }
    info!(
        rides = ride_ids.len(),
        cues = total.cues,
        new_marks = total.marks_created,
        "turn cues computed"
    );
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples_from(names: &[Option<&str>]) -> Vec<RoadSample> {
        // Straight line heading east, one sample per 15 m.
        names
            .iter()
            .enumerate()
            .map(|(i, n)| RoadSample {
                lon: 151.0 + i as f64 * 0.00016,
                lat: -33.7,
                dist_m: i as f64 * 15.0,
                road: n.map(String::from),
            })
            .collect()
    }

    #[test]
    fn straight_name_change_is_s() {
        let a = Some("Putty Rd");
        let b = Some("Cobah Rd");
        let samples = samples_from(&[a, a, a, a, b, b, b, b]);
        let events = detect_turns(&samples);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].dir, TurnDir::Straight);
        assert_eq!(events[0].from_road, "Putty Rd");
        assert_eq!(events[0].onto_road, "Cobah Rd");
        assert_eq!(events[0].dist_m, 60.0);
    }

    #[test]
    fn right_turn_detected() {
        // East along A, then south along B: a right turn.
        let mut samples: Vec<RoadSample> = (0..5)
            .map(|i| RoadSample {
                lon: 151.0 + i as f64 * 0.00016,
                lat: -33.7,
                dist_m: i as f64 * 15.0,
                road: Some("A St".into()),
            })
            .collect();
        for i in 0..5 {
            samples.push(RoadSample {
                lon: 151.0 + 4.0 * 0.00016,
                lat: -33.7 - (i + 1) as f64 * 0.000135,
                dist_m: (5 + i) as f64 * 15.0,
                road: Some("B St".into()),
            });
        }
        let events = detect_turns(&samples);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].dir, TurnDir::Right);
    }

    #[test]
    fn flicker_run_is_noise() {
        let a = Some("A St");
        let x = Some("Crossing Rd"); // 2 samples: below MIN_RUN_SAMPLES
        let samples = samples_from(&[a, a, a, a, x, x, a, a, a, a]);
        assert!(detect_turns(&samples).is_empty());
    }

    #[test]
    fn short_gap_still_cues_long_gap_does_not() {
        let a = Some("A St");
        let b = Some("B St");
        // 4-sample gap (roundabout): cues.
        let mut v: Vec<Option<&str>> = vec![a; 4];
        v.extend([None; 4]);
        v.extend([b; 4]);
        assert_eq!(detect_turns(&samples_from(&v)).len(), 1);
        // 12-sample gap (~180 m off-road): silent.
        let mut v: Vec<Option<&str>> = vec![a; 4];
        v.extend([None; 12]);
        v.extend([b; 4]);
        assert!(detect_turns(&samples_from(&v)).is_empty());
    }

    #[test]
    fn same_road_after_gap_is_silent() {
        let a = Some("A St");
        let mut v: Vec<Option<&str>> = vec![a; 4];
        v.extend([None; 3]);
        v.extend([a; 4]);
        assert!(detect_turns(&samples_from(&v)).is_empty());
    }

    #[test]
    fn resample_interpolates_long_segments() {
        // Two vertices 1 km apart: expect ~66 interpolated samples.
        let pts = vec![(151.0, -33.7), (151.0, -33.691)]; // ~1000 m north
        let r = resample(&pts);
        assert!(r.len() > 60 && r.len() < 70, "got {}", r.len());
        assert_eq!(r[0].2, 0.0);
        assert!((r[1].2 - 15.0).abs() < 1e-9);
    }
}
