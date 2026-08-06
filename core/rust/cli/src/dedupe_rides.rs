//! `dingo dedupe-rides` — find duplicate recordings of the same ride and
//! supersede all but one per cluster.
//!
//! Two recorded rides count as THE SAME RIDE when they started at the same
//! time and place and ran for the same duration (Grant's rule) — plus a
//! track-length sanity check so two different loops from the same trailhead
//! with coincidentally equal durations can't merge:
//!   - start times within --start-time-s (default 600 s; re-exports of one
//!     recording share the start instant, separate laps are hours apart)
//!   - start points within --start-m (default 100 m)
//!   - duration within --duration-s (default 60 s — exports of the same
//!     recording can disagree by trimmed standby seconds)
//!   - track length within --length-pct (default 10%)
//!
//! This catches the Garmin-archive vs Strava-export overlap: the same
//! recording exported twice with different bytes (trimming, format), which
//! content-hash dedup can't see. Plans (routes) are never touched — see
//! dedupe-plans for those.
//!
//! Report mode (default) prints clusters with the suggested keeper (HR data
//! first, then most points, then earliest import). `--apply` marks losers
//! `superseded_by` the keeper and, when their exported GPX is known, moves
//! it into `<dest>/Duplicates/`.

use std::collections::HashMap;
use std::path::Path;

use sqlx::types::Uuid;
use sqlx::{PgPool, Row};
use tracing::warn;

use crate::organize::move_into;

/// One ride involved in a duplicate cluster.
pub struct RideEntry {
    pub id: Uuid,
    pub name: Option<String>,
    pub day: Option<String>,
    pub points: i32,
    pub has_hr: bool,
    pub exported_path: Option<String>,
}

/// A cluster of duplicate recordings; `rides[0]` is the suggested keeper.
pub struct RideCluster {
    pub rides: Vec<RideEntry>,
}

#[derive(Debug, Default)]
pub struct DedupeRidesSummary {
    pub clusters: usize,
    pub rides_superseded: usize,
    pub files_moved: usize,
}

/// Matching thresholds (CLI flags).
pub struct Thresholds {
    pub start_m: f64,
    pub start_time_s: f64,
    pub duration_s: f64,
    pub length_pct: f64,
}

pub async fn find_clusters(pool: &PgPool, t: &Thresholds) -> anyhow::Result<Vec<RideCluster>> {
    // Precompute per-ride day/duration/start/length once, then self-join on
    // the day — per-day candidate sets are tiny, so the geography casts
    // (which bypass the GiST index) only run on a handful of pairs.
    let pairs = sqlx::query(
        r#"
        WITH r AS (
            SELECT id,
                   started_at::date AS day,
                   started_at,
                   EXTRACT(EPOCH FROM (ended_at - started_at)) AS dur_s,
                   ST_StartPoint(cleaned_geometry)::geography AS start_pt,
                   ST_Length(cleaned_geometry::geography) AS len_m
            FROM rides
            WHERE track_type = 'ride'
              AND superseded_by IS NULL
              AND cleaned_geometry IS NOT NULL
              AND started_at IS NOT NULL AND ended_at IS NOT NULL
        )
        SELECT a.id AS id_a, b.id AS id_b
        FROM r a
        JOIN r b ON b.day = a.day AND b.id > a.id
        WHERE ABS(EXTRACT(EPOCH FROM (a.started_at - b.started_at))) <= $4
          AND ABS(a.dur_s - b.dur_s) <= $1
          AND ST_DWithin(a.start_pt, b.start_pt, $2)
          AND ABS(a.len_m - b.len_m) <= $3 * GREATEST(a.len_m, b.len_m)
        "#,
    )
    .bind(t.duration_s)
    .bind(t.start_m)
    .bind(t.length_pct / 100.0)
    .bind(t.start_time_s)
    .fetch_all(pool)
    .await?;

    // Union-find over matched pairs.
    let mut parent: HashMap<Uuid, Uuid> = HashMap::new();
    fn find(parent: &mut HashMap<Uuid, Uuid>, x: Uuid) -> Uuid {
        let p = *parent.entry(x).or_insert(x);
        if p == x {
            x
        } else {
            let root = find(parent, p);
            parent.insert(x, root);
            root
        }
    }
    for row in &pairs {
        let (a, b): (Uuid, Uuid) = (row.get("id_a"), row.get("id_b"));
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra != rb {
            parent.insert(ra, rb);
        }
    }

    let mut groups: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let ids: Vec<Uuid> = parent.keys().copied().collect();
    for id in ids {
        let root = find(&mut parent, id);
        groups.entry(root).or_default().push(id);
    }

    let all_ids: Vec<Uuid> = groups.values().flatten().copied().collect();
    if all_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        r#"
        SELECT id, name, exported_path, has_heart_rate,
               to_char(started_at, 'YYYY-MM-DD') AS day,
               EXTRACT(EPOCH FROM imported_at)::float8 AS imported_epoch,
               ST_NPoints(cleaned_geometry) AS points
        FROM rides WHERE id = ANY($1)
        "#,
    )
    .bind(&all_ids)
    .fetch_all(pool)
    .await?;
    let mut info: HashMap<Uuid, (RideEntry, f64)> = rows
        .into_iter()
        .map(|r| {
            let id: Uuid = r.get("id");
            let entry = RideEntry {
                id,
                name: r.get("name"),
                day: r.get("day"),
                points: r.get::<Option<i32>, _>("points").unwrap_or(0),
                has_hr: r.get("has_heart_rate"),
                exported_path: r.get("exported_path"),
            };
            (id, (entry, r.get::<Option<f64>, _>("imported_epoch").unwrap_or(0.0)))
        })
        .collect();

    let mut clusters: Vec<RideCluster> = Vec::new();
    for (_, members) in groups {
        if members.len() < 2 {
            continue;
        }
        let mut rides: Vec<(RideEntry, f64)> = members
            .iter()
            .filter_map(|id| info.remove(id))
            .collect();
        // Keeper first: HR beats no-HR, then most points, then EARLIEST
        // import (the original archive copy over later re-exports).
        rides.sort_by(|(a, ta), (b, tb)| {
            b.has_hr
                .cmp(&a.has_hr)
                .then(b.points.cmp(&a.points))
                .then(ta.partial_cmp(tb).unwrap_or(std::cmp::Ordering::Equal))
        });
        clusters.push(RideCluster {
            rides: rides.into_iter().map(|(e, _)| e).collect(),
        });
    }
    // Deterministic output order: by keeper day then name.
    clusters.sort_by(|a, b| {
        a.rides[0]
            .day
            .cmp(&b.rides[0].day)
            .then(a.rides[0].name.cmp(&b.rides[0].name))
    });
    Ok(clusters)
}

/// Print the cluster report (first `max_shown` clusters in full).
pub fn print_report(clusters: &[RideCluster], t: &Thresholds, apply: bool) {
    if clusters.is_empty() {
        println!(
            "✅ No duplicate recordings found (start time ±{:.0} s, start ≤{:.0} m, duration ±{:.0} s, length ±{:.0}%).",
            t.start_time_s, t.start_m, t.duration_s, t.length_pct
        );
        return;
    }
    let dupes: usize = clusters.iter().map(|c| c.rides.len() - 1).sum();
    println!(
        "Found {} duplicate cluster(s) covering {} redundant recording(s):\n",
        clusters.len(),
        dupes
    );
    let max_shown = 15;
    for (i, cluster) in clusters.iter().take(max_shown).enumerate() {
        println!("Cluster {} — {} copies", i + 1, cluster.rides.len());
        for (j, ride) in cluster.rides.iter().enumerate() {
            let marker = if j == 0 { "KEEP " } else { "  ↳  " };
            println!(
                "   {marker}{} {} ({} pts{})",
                ride.day.as_deref().unwrap_or("????-??-??"),
                ride.name.as_deref().unwrap_or("<unnamed>"),
                ride.points,
                if ride.has_hr { ", HR" } else { "" },
            );
        }
    }
    if clusters.len() > max_shown {
        println!("   … and {} more cluster(s)", clusters.len() - max_shown);
    }
    if !apply {
        println!("\nDry run — re-run with --apply to supersede the non-keepers.");
    }
}

/// Apply: mark non-keepers superseded and shelve their exported files.
pub async fn apply(
    pool: &PgPool,
    clusters: &[RideCluster],
    dest: Option<&Path>,
) -> anyhow::Result<DedupeRidesSummary> {
    let mut summary = DedupeRidesSummary {
        clusters: clusters.len(),
        ..Default::default()
    };
    for cluster in clusters {
        let keeper = cluster.rides[0].id;
        for loser in &cluster.rides[1..] {
            // Supersede the loser and move any photos onto the keeper — otherwise
            // photos keep pointing at a ride that no longer appears in any
            // listing. exported_path is cleared only AFTER the file is shelved
            // (below), so an interrupted move can't orphan the GPX.
            sqlx::query("UPDATE rides SET superseded_by = $1 WHERE id = $2")
                .bind(keeper)
                .bind(loser.id)
                .execute(pool)
                .await?;
            sqlx::query("UPDATE photos SET ride_id = $1 WHERE ride_id = $2")
                .bind(keeper)
                .bind(loser.id)
                .execute(pool)
                .await?;
            summary.rides_superseded += 1;

            if let (Some(dest), Some(rel)) = (dest, loser.exported_path.as_deref()) {
                let file = dest.join(rel);
                let clear_pointer = if file.exists() {
                    match move_into(&file, &dest.join("Duplicates")) {
                        Ok(()) => {
                            summary.files_moved += 1;
                            true
                        }
                        Err(e) => {
                            warn!(file = %file.display(), error = %e, "Failed to shelve superseded ride");
                            false // leave exported_path so the file isn't orphaned
                        }
                    }
                } else {
                    true // file already gone — safe to clear the stale pointer
                };
                if clear_pointer {
                    sqlx::query("UPDATE rides SET exported_path = NULL WHERE id = $1")
                        .bind(loser.id)
                        .execute(pool)
                        .await?;
                }
            }
        }
    }
    Ok(summary)
}
