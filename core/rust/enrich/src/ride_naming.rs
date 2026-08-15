//! Ride name generation per the documented convention:
//!
//! - Loop:    `<Suburb> loop [via <Mid>] <D> kms <H> hrs on <YYYY-MM-DD>`
//! - One-way: `<Suburb> to <End> [via <Mid>] <D> kms <H> hrs on <YYYY-MM-DD>`
//!
//! Names are suburb-only (no LGA prefix); the LGA/state/region live in ride
//! attribute columns instead.
//!
//! The generated name is written to `rides.generated_name` and never to
//! `rides.name` directly — `name_source` decides which of the four variants
//! (`original_name`, `filename`, `generated_name`, `custom_name`) displays,
//! and `resolve_ride_name()` in the database resolves it. This pass therefore
//! cannot destroy a name a user chose: it owns one column and refreshes only
//! that one.
//!
//! It also no longer appends the ingested name in parens
//! (`... on 2024-03-29 (Maroota Secret Track)`). The original now has its own
//! column, so the suffix was pure duplication.
//!
//! The same pass fills the ride locality attributes: `suburbs` and `lgas` are
//! ALL localities the ride passes through (nearest locality sampled roughly
//! every km, ordered by first encounter), `state` is the majority state over
//! those samples, and `region` comes from the curated (state, LGA) -> region
//! map (see gazetteer::RegionMap).

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::{info, warn};

use dingo_core::Result;

use crate::gazetteer::{Locality, RegionMap, load_region_map, locality_count, nearest_locality};

/// A ride is a loop when start and end are within this distance...
const LOOP_CLOSURE_M: f64 = 500.0;
/// ...or within this fraction of total ride length (long rides drift more).
const LOOP_CLOSURE_FRACTION: f64 = 0.02;

/// The single loop rule — shared by naming ("X loop" vs "X to Y") and, via
/// the stored `rides.is_loop`, library placement (a non-loop track sits at
/// the deepest level where its start and end localities agree).
pub fn is_closed_loop(closure_m: f64, distance_m: f64) -> bool {
    closure_m < LOOP_CLOSURE_M.max(distance_m * LOOP_CLOSURE_FRACTION)
}

/// Whether an ingested name is meaningless boilerplate. Defined in
/// `dingo_core` because the ingest path needs the same answer to choose a
/// ride's initial `name_source`; re-exported here for existing callers.
pub use dingo_core::is_junk_name;

/// Summary of a naming pass
#[derive(Debug, Default)]
pub struct NamingSummary {
    pub rides_processed: usize,
    pub rides_named: usize,
    /// Rides displaying a custom name that already hold a generated one, so
    /// this pass left them alone. They keep both — switching back is a
    /// pointer change, not a re-run.
    pub rides_skipped_user: usize,
    pub rides_failed: usize,
    /// A few example generated names for eyeballing
    pub samples: Vec<String>,
}

struct RideNameInput {
    id: uuid::Uuid,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
    start: (f64, f64),
    end: (f64, f64),
    mid: (f64, f64),
    distance_m: f64,
    closure_m: f64,
}

/// Locality attributes derived from sampling the ride's track.
#[derive(Debug, Default)]
struct RideLocalities {
    /// Distinct suburbs in first-encounter order (start first)
    suburbs: Vec<String>,
    /// Distinct LGAs in first-encounter order
    lgas: Vec<String>,
    /// Majority state over the samples
    state: Option<String>,
    /// Region of the first covered LGA with a mapping (majority state)
    region: Option<String>,
}

/// Format the duration part: 1 decimal under 10 h, integer otherwise.
fn format_duration_hrs(hours: f64) -> String {
    if hours < 10.0 {
        format!("{hours:.1} hrs")
    } else {
        format!("{} hrs", hours.round() as i64)
    }
}

/// Assemble the name from resolved parts. Pure function for testability.
fn assemble_name(
    start: &Locality,
    end: &Locality,
    mid: &Locality,
    is_loop: bool,
    distance_km: f64,
    duration_hours: Option<f64>,
    date: Option<&str>,
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(8);
    parts.push(start.suburb.clone());

    // "X to X" reads badly — an out-and-back within one suburb is a loop
    // for naming purposes even when the GPS endpoints don't close.
    if is_loop || start.suburb == end.suburb {
        parts.push("loop".to_string());
    } else {
        parts.push(format!("to {}", end.suburb));
    }

    // "via" only when the midpoint adds information
    if mid.suburb != start.suburb && mid.suburb != end.suburb {
        parts.push(format!("via {}", mid.suburb));
    }

    parts.push(format!("{} kms", distance_km.round() as i64));
    if let Some(h) = duration_hours {
        parts.push(format_duration_hrs(h));
    }
    if let Some(d) = date {
        parts.push(format!("on {d}"));
    }

    parts.join(" ")
}

/// Fold KNN samples along the track into ordered-distinct suburbs/LGAs,
/// majority state, and a region. Pure function for testability.
fn aggregate_localities(samples: &[Locality], regions: &RegionMap) -> RideLocalities {
    let mut out = RideLocalities::default();
    let mut state_counts: std::collections::HashMap<&str, usize> = Default::default();

    for s in samples {
        if !out.suburbs.contains(&s.suburb) {
            out.suburbs.push(s.suburb.clone());
        }
        if let Some(lga) = &s.lga {
            if !out.lgas.contains(lga) {
                out.lgas.push(lga.clone());
            }
        }
        if let Some(st) = &s.state {
            *state_counts.entry(st.as_str()).or_default() += 1;
        }
    }

    out.state = state_counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(s, _)| s.to_string());

    // Region comes from the first LGA the ride passes through that belongs to
    // its MAJORITY state — so a NSW ride that briefly clips a Victorian LGA is
    // still filed under a NSW region, not "Gippsland". Falls back to the
    // state-wide default row. (Mirrored by backfill_regions in SQL.)
    if let Some(state) = &out.state {
        out.region = samples
            .iter()
            .filter(|s| s.state.as_deref() == Some(state.as_str()))
            .find_map(|s| regions.region_for(state, s.lga.as_deref()))
            .or_else(|| regions.region_for(state, None))
            .map(str::to_string);
    }
    out
}

/// Nearest locality at ~1 km intervals along the ride (capped at 200 samples,
/// endpoints always included), in track order.
async fn sample_ride_localities(pool: &PgPool, ride_id: uuid::Uuid) -> Result<Vec<Locality>> {
    let rows = sqlx::query(
        r#"
        WITH ride AS (
            SELECT cleaned_geometry AS g,
                   LEAST(GREATEST(CEIL(ST_Length(cleaned_geometry::geography) / 1000.0)::int, 1), 200) AS n
            FROM rides WHERE id = $1 AND cleaned_geometry IS NOT NULL
        )
        SELECT l.suburb, l.lga, l.state
        FROM ride, generate_series(0, ride.n) AS i
        CROSS JOIN LATERAL (
            SELECT suburb, lga, state FROM localities
            ORDER BY location <-> ST_LineInterpolatePoint(ride.g, i::float8 / ride.n)
            LIMIT 1
        ) l
        ORDER BY i
        "#,
    )
    .bind(ride_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| Locality {
            suburb: r.get("suburb"),
            lga: r.get("lga"),
            state: r.get("state"),
        })
        .collect())
}

/// Generate and store names + locality attributes for all eligible rides.
pub async fn name_all_rides(pool: &PgPool) -> Result<NamingSummary> {
    name_rides(pool, false).await
}

/// Like [`name_all_rides`], but only (re)names rides that don't yet have
/// locality attributes (`state IS NULL`) — new or previously-unlocatable
/// rides. The region backfill still runs over every ride, so this is the fast
/// path for repeated bulk imports where most rides are already named.
pub async fn name_unlocated_rides(pool: &PgPool) -> Result<NamingSummary> {
    name_rides(pool, true).await
}

async fn name_rides(pool: &PgPool, only_unlocated: bool) -> Result<NamingSummary> {
    if locality_count(pool).await? == 0 {
        return Err(dingo_core::Error::InvalidInput(
            "Gazetteer is empty — run `dingo gazetteer load data/gazetteer-au.tsv` first".into(),
        ));
    }
    let regions = load_region_map(pool).await?;
    if regions.is_empty() {
        warn!(
            "lga_regions is empty — ride regions will be NULL \
             (run `dingo gazetteer load-regions data/lga-regions-au.tsv`)"
        );
    }

    let unlocated_clause = if only_unlocated { "AND state IS NULL" } else { "" };
    let rows = sqlx::query(&format!(
        r#"
        SELECT id, started_at, ended_at,
               ST_X(ST_StartPoint(cleaned_geometry)) as sx, ST_Y(ST_StartPoint(cleaned_geometry)) as sy,
               ST_X(ST_EndPoint(cleaned_geometry))   as ex, ST_Y(ST_EndPoint(cleaned_geometry))   as ey,
               ST_X(ST_LineInterpolatePoint(cleaned_geometry, 0.5)) as mx,
               ST_Y(ST_LineInterpolatePoint(cleaned_geometry, 0.5)) as my,
               ST_Length(cleaned_geometry::geography) as distance_m,
               ST_Distance(ST_StartPoint(cleaned_geometry)::geography,
                           ST_EndPoint(cleaned_geometry)::geography) as closure_m
        FROM rides
        WHERE cleaned_geometry IS NOT NULL
          AND ST_NPoints(cleaned_geometry) >= 2
          -- A custom name is the user's choice, so once such a ride already
          -- holds a generated name there is nothing to refresh. It is still
          -- named once, so the picker can offer the auto name as an option.
          AND (name_source != 'custom' OR generated_name IS NULL)
          -- Never name planned routes: their curated names (e.g. the GOAT
          -- track names) ARE the payload, and they'd otherwise qualify — they
          -- carry cleaned_geometry like any recorded ride.
          AND kind = 'recorded'
          {unlocated_clause}
        "#,
    ))
    .fetch_all(pool)
    .await?;

    let mut summary = NamingSummary {
        rides_skipped_user: sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM rides
              WHERE name_source = 'custom' AND generated_name IS NOT NULL
                AND kind = 'recorded'",
        )
        .fetch_one(pool)
        .await? as usize,
        ..Default::default()
    };

    for row in rows {
        let input = RideNameInput {
            id: row.get("id"),
            started_at: row.get("started_at"),
            ended_at: row.get("ended_at"),
            start: (row.get("sx"), row.get("sy")),
            end: (row.get("ex"), row.get("ey")),
            mid: (row.get("mx"), row.get("my")),
            distance_m: row.get("distance_m"),
            closure_m: row.get("closure_m"),
        };
        summary.rides_processed += 1;

        match name_one_ride(pool, &input, &regions).await {
            Ok(name) => {
                if summary.samples.len() < 15 {
                    summary.samples.push(name);
                }
                summary.rides_named += 1;
            }
            Err(e) => {
                warn!(ride_id = %input.id, error = %e, "Failed to name ride");
                summary.rides_failed += 1;
            }
        }
    }

    // Recompute region for every located ride from its stored state + lgas so
    // the value always matches the current lga_regions map and the
    // majority-state rule — including rides skipped above (only_unlocated) and
    // pre-existing rows whose region predates a map edit. Set-based + cheap.
    backfill_regions(pool).await?;

    info!(
        named = summary.rides_named,
        failed = summary.rides_failed,
        "Ride naming complete"
    );
    Ok(summary)
}

/// Locality-only pass for planned routes: the same state/region/LGA/suburb
/// sampling as naming, but the name columns are never touched — curated
/// route names (e.g. the GOAT tracks) are the payload. Only rides still
/// missing a state are processed, so re-imports converge quickly.
pub async fn locate_planned_rides(pool: &PgPool) -> Result<usize> {
    if locality_count(pool).await? == 0 {
        return Err(dingo_core::Error::InvalidInput(
            "Gazetteer is empty — run `dingo gazetteer load data/gazetteer-au.tsv` first".into(),
        ));
    }
    let regions = load_region_map(pool).await?;

    let rows = sqlx::query(
        r#"
        SELECT id,
               ST_X(ST_EndPoint(cleaned_geometry)) as ex, ST_Y(ST_EndPoint(cleaned_geometry)) as ey,
               ST_Length(cleaned_geometry::geography) as distance_m,
               ST_Distance(ST_StartPoint(cleaned_geometry)::geography,
                           ST_EndPoint(cleaned_geometry)::geography) as closure_m
        FROM rides
        WHERE kind = 'planned'
          AND cleaned_geometry IS NOT NULL
          AND ST_NPoints(cleaned_geometry) >= 2
          AND state IS NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut located = 0usize;
    for row in rows {
        let id: uuid::Uuid = row.get("id");
        let samples = sample_ride_localities(pool, id).await?;
        let locs = aggregate_localities(&samples, &regions);
        if locs.state.is_none() {
            continue;
        }
        let end = nearest_locality(pool, row.get("ex"), row.get("ey")).await?;
        let end_region = end.as_ref().and_then(|e| {
            e.state
                .as_deref()
                .and_then(|st| regions.region_for(st, e.lga.as_deref()))
                .map(str::to_string)
        });
        let is_loop = is_closed_loop(row.get("closure_m"), row.get("distance_m"));

        sqlx::query(
            r#"
            UPDATE rides SET
                state = $2, region = $3, lgas = $4, suburbs = $5,
                end_state = $6, end_region = $7, end_lga = $8, end_suburb = $9,
                is_loop = $10
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&locs.state)
        .bind(&locs.region)
        .bind(&locs.lgas)
        .bind(&locs.suburbs)
        .bind(end.as_ref().and_then(|e| e.state.clone()))
        .bind(&end_region)
        .bind(end.as_ref().and_then(|e| e.lga.clone()))
        .bind(end.as_ref().map(|e| e.suburb.clone()))
        .bind(is_loop)
        .execute(pool)
        .await?;
        located += 1;
    }

    Ok(located)
}

/// Set-based region repair: `region` = the first LGA (in encounter order) that
/// both the ride passes through and maps under the ride's majority state,
/// falling back to the state-wide default. Idempotent; mirrors the in-code
/// logic in [`aggregate_localities`].
pub async fn backfill_regions(pool: &PgPool) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE rides r SET region = COALESCE(
            (SELECT lr.region FROM lga_regions lr
             WHERE lr.state = r.state AND lr.lga <> '' AND lr.lga = ANY(r.lgas)
             ORDER BY array_position(r.lgas, lr.lga) LIMIT 1),
            (SELECT lr.region FROM lga_regions lr
             WHERE lr.state = r.state AND lr.lga = '' LIMIT 1)
        )
        WHERE r.state IS NOT NULL
        "#,
    )
    .execute(pool)
    .await?;
    // Same repair for the end-of-track region (single LGA, no encounter order).
    sqlx::query(
        r#"
        UPDATE rides r SET end_region = COALESCE(
            (SELECT lr.region FROM lga_regions lr
             WHERE lr.state = r.end_state AND lr.lga <> '' AND lr.lga = r.end_lga LIMIT 1),
            (SELECT lr.region FROM lga_regions lr
             WHERE lr.state = r.end_state AND lr.lga = '' LIMIT 1)
        )
        WHERE r.end_state IS NOT NULL
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn name_one_ride(pool: &PgPool, input: &RideNameInput, regions: &RegionMap) -> Result<String> {
    let start = nearest_locality(pool, input.start.0, input.start.1)
        .await?
        .ok_or_else(|| dingo_core::Error::NotFound("no locality near start".into()))?;
    let end = nearest_locality(pool, input.end.0, input.end.1)
        .await?
        .ok_or_else(|| dingo_core::Error::NotFound("no locality near end".into()))?;
    let mid = nearest_locality(pool, input.mid.0, input.mid.1)
        .await?
        .ok_or_else(|| dingo_core::Error::NotFound("no locality near midpoint".into()))?;

    let is_loop = is_closed_loop(input.closure_m, input.distance_m);

    // Cap at 48 h: planned-route files sometimes carry bogus timestamps
    // spanning months, which would render as "7781 hrs".
    let duration_hours = match (input.started_at, input.ended_at) {
        (Some(s), Some(e)) if e > s && (e - s).num_hours() < 48 => {
            Some((e - s).num_seconds() as f64 / 3600.0)
        }
        _ => None,
    };
    let date = input.started_at.map(|t| t.format("%Y-%m-%d").to_string());

    let name = assemble_name(
        &start,
        &end,
        &mid,
        is_loop,
        input.distance_m / 1000.0,
        duration_hours,
        date.as_deref(),
    );

    let samples = sample_ride_localities(pool, input.id).await?;
    let locs = aggregate_localities(&samples, regions);

    // End-of-track locality attributes (placement's non-loop ceiling compares
    // these against the start values). Region mirrors aggregate_localities'
    // lookup: (state, LGA) mapping first, state-wide default second.
    let end_region = end
        .state
        .as_deref()
        .and_then(|st| regions.region_for(st, end.lga.as_deref()))
        .map(str::to_string);

    // Write only the column this pass owns, then re-resolve the display name
    // through the single database definition. `name_source` is deliberately
    // untouched: the pointer is the user's choice, not the namer's.
    sqlx::query(
        r#"
        UPDATE rides SET
            generated_name = $2,
            name = resolve_ride_name(
                name_source::TEXT, original_name, filename, $2, custom_name),
            state = $3,
            region = $4,
            lgas = $5,
            suburbs = $6,
            end_state = $7,
            end_region = $8,
            end_lga = $9,
            end_suburb = $10,
            is_loop = $11
        WHERE id = $1
        "#,
    )
    .bind(input.id)
    .bind(&name)
    .bind(&locs.state)
    .bind(&locs.region)
    .bind(&locs.lgas)
    .bind(&locs.suburbs)
    .bind(&end.state)
    .bind(&end_region)
    .bind(&end.lga)
    .bind(&end.suburb)
    .bind(is_loop)
    .execute(pool)
    .await?;

    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc(suburb: &str, lga: Option<&str>) -> Locality {
        Locality {
            suburb: suburb.into(),
            lga: lga.map(str::to_string),
            state: Some("NSW".into()),
        }
    }

    #[test]
    fn loop_rule_thresholds() {
        // Short ride: the 500 m absolute floor governs
        assert!(is_closed_loop(499.0, 10_000.0));
        assert!(!is_closed_loop(501.0, 10_000.0));
        // Long ride: 2 % of length governs (60 km → 1200 m allowance)
        assert!(is_closed_loop(1_100.0, 60_000.0));
        assert!(!is_closed_loop(1_300.0, 60_000.0));
        // Point-to-point is never a loop
        assert!(!is_closed_loop(80_000.0, 100_000.0));
    }

    // is_junk_name moved to dingo_core::track_name; its tests moved with it.

    /// The ingested name lives in its own column now, so it must NOT appear
    /// in the generated one — that duplication is what the 2026-08-11
    /// migration strips out of 822 existing rows.
    #[test]
    fn generated_name_never_embeds_the_original() {
        let name = assemble_name(
            &loc("Maroota", Some("The Hills")),
            &loc("Maroota", Some("The Hills")),
            &loc("Canoelands", Some("Hornsby")),
            true,
            31.2,
            Some(2.8),
            Some("2025-06-01"),
        );
        assert_eq!(
            name,
            "Maroota loop via Canoelands 31 kms 2.8 hrs on 2025-06-01"
        );
        assert!(!name.contains('('), "no bracketed suffix: {name}");
    }

    #[test]
    fn one_way_reads_start_to_end() {
        let name = assemble_name(
            &loc("Wisemans Ferry", Some("Hornsby")),
            &loc("St Albans", Some("Hawkesbury")),
            &loc("Webbs Creek", Some("Hawkesbury")),
            false,
            74.4,
            Some(3.2),
            Some("2011-09-02"),
        );
        assert_eq!(
            name,
            "Wisemans Ferry to St Albans via Webbs Creek 74 kms 3.2 hrs on 2011-09-02"
        );
    }

    #[test]
    fn route_without_timestamps_omits_time_parts() {
        let name = assemble_name(
            &loc("Jindabyne", Some("Snowy Monaro")),
            &loc("Omeo", Some("East Gippsland")),
            &loc("Benambra", Some("East Gippsland")),
            false,
            597.0,
            None,
            None,
        );
        assert_eq!(name, "Jindabyne to Omeo via Benambra 597 kms");
    }

    #[test]
    fn long_duration_integer_hours() {
        assert_eq!(format_duration_hrs(12.6), "13 hrs");
        assert_eq!(format_duration_hrs(3.25), "3.2 hrs");
    }

    #[test]
    fn same_suburb_out_and_back_reads_as_loop() {
        let name = assemble_name(
            &loc("Eden", Some("Bega Valley")),
            &loc("Eden", Some("Bega Valley")),
            &loc("Nullica", Some("Bega Valley")),
            false, // GPS endpoints didn't close, but same suburb
            35.0,
            Some(3.4),
            Some("2024-03-22"),
        );
        assert_eq!(name, "Eden loop via Nullica 35 kms 3.4 hrs on 2024-03-22");
    }

    #[test]
    fn mid_same_as_start_omitted() {
        let name = assemble_name(
            &loc("Maroota", Some("The Hills")),
            &loc("Maroota", Some("The Hills")),
            &loc("Maroota", Some("The Hills")),
            true,
            10.0,
            Some(1.0),
            Some("2025-01-01"),
        );
        assert_eq!(name, "Maroota loop 10 kms 1.0 hrs on 2025-01-01");
    }

    #[test]
    fn localities_aggregate_ordered_distinct_with_majority_state() {
        let mut samples = vec![
            loc("Palm Dale", Some("Central Coast")),
            loc("Palm Dale", Some("Central Coast")),
            loc("Palm Grove", Some("Central Coast")),
            loc("Ourimbah", Some("Central Coast")),
            loc("Palm Dale", Some("Central Coast")),
        ];
        samples[3].state = Some("QLD".into()); // stray sample doesn't flip majority

        let agg = aggregate_localities(&samples, &RegionMap::default());
        assert_eq!(agg.suburbs, vec!["Palm Dale", "Palm Grove", "Ourimbah"]);
        assert_eq!(agg.lgas, vec!["Central Coast"]);
        assert_eq!(agg.state.as_deref(), Some("NSW"));
        assert_eq!(agg.region, None); // empty region map
    }
}
