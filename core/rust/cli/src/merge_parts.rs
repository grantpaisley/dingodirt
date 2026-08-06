//! `dingo merge-parts` — stitch multi-part recordings of one outing back
//! into a single ride.
//!
//! In the early recording days (roughly 2011–2019) a single outing was often
//! saved as many arbitrary fragments — device auto-splits and stop/start
//! habits produced up to ~200 files for one day out. Two live rides count as
//! consecutive PARTS of the same outing when:
//!   - the second starts within [-60 s .. --max-gap-min] of the first ending
//!   - the second's start point is within --max-dist-m of the first's end point
//! Chains are built transitively (union-find), so A→B→C→… collapses to one.
//!
//! Report mode (default) prints the chains. `--apply` inserts a brand-new
//! merged ride per chain (concatenated raw time series + geometry, min/max
//! times, OR'd sensor flags) and marks every part `superseded_by` the merged
//! ride — nothing is deleted, so the merge is fully reversible. The merged
//! ride is born uncleaned and unlocated, so the next `dingo clean --all`
//! picks it up and names it like a fresh import.

use std::collections::HashMap;
use std::path::Path;

use sqlx::types::chrono::{DateTime, Utc};
use sqlx::types::Uuid;
use sqlx::{PgPool, Row};
use tracing::warn;

use crate::organize::move_into;

/// One part of a multi-part chain.
pub struct PartEntry {
    pub id: Uuid,
    pub name: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub exported_path: Option<String>,
}

/// A chain of consecutive parts; ordered by start time.
pub struct Chain {
    pub parts: Vec<PartEntry>,
}

#[derive(Debug, Default)]
pub struct MergePartsSummary {
    pub chains: usize,
    pub rides_created: usize,
    pub parts_superseded: usize,
    pub files_moved: usize,
    pub chains_skipped: usize,
}

/// Matching thresholds (CLI flags).
pub struct Thresholds {
    pub max_gap_min: f64,
    pub max_dist_m: f64,
}

pub async fn find_chains(pool: &PgPool, t: &Thresholds) -> anyhow::Result<Vec<Chain>> {
    // Pairwise "b continues a" candidates. Raw geometry endpoints (not
    // cleaned) because the merge operates on raw data; the distance
    // threshold absorbs endpoint GPS noise.
    let pairs = sqlx::query(
        r#"
        -- NOT MATERIALIZED so the planner inlines this into both sides of the
        -- self-join and can drive the time-window join from an index on
        -- started_at, instead of materialising the CTE and nested-looping every
        -- pair. A functional GiST index on ST_EndPoint(raw_geometry)::geography
        -- would let ST_DWithin use an index too (future migration).
        WITH r AS NOT MATERIALIZED (
            SELECT id, started_at, ended_at,
                   ST_StartPoint(raw_geometry)::geography AS sp,
                   ST_EndPoint(raw_geometry)::geography AS ep
            FROM rides
            WHERE track_type = 'ride'
              AND superseded_by IS NULL
              AND started_at IS NOT NULL AND ended_at IS NOT NULL
              AND raw_geometry IS NOT NULL AND raw_time_series IS NOT NULL
        )
        SELECT a.id AS id_a, b.id AS id_b
        FROM r a
        JOIN r b ON b.id <> a.id
               AND b.started_at >= a.ended_at - interval '60 seconds'
               AND b.started_at <= a.ended_at + make_interval(secs => $1)
        WHERE ST_DWithin(a.ep, b.sp, $2)
        "#,
    )
    .bind(t.max_gap_min * 60.0)
    .bind(t.max_dist_m)
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
        SELECT id, name, started_at, ended_at, exported_path
        FROM rides WHERE id = ANY($1)
        "#,
    )
    .bind(&all_ids)
    .fetch_all(pool)
    .await?;
    let mut info: HashMap<Uuid, PartEntry> = rows
        .into_iter()
        .map(|r| {
            let id: Uuid = r.get("id");
            (
                id,
                PartEntry {
                    id,
                    name: r.get("name"),
                    started_at: r.get("started_at"),
                    ended_at: r.get("ended_at"),
                    exported_path: r.get("exported_path"),
                },
            )
        })
        .collect();

    let mut chains: Vec<Chain> = Vec::new();
    for (_, members) in groups {
        if members.len() < 2 {
            continue;
        }
        let mut parts: Vec<PartEntry> = members
            .iter()
            .filter_map(|id| info.remove(id))
            .collect();
        parts.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));
        chains.push(Chain { parts });
    }
    chains.sort_by_key(|c| c.parts[0].started_at);
    Ok(chains)
}

/// Print the chain report (first `max_shown` chains in full).
pub fn print_report(chains: &[Chain], t: &Thresholds, apply: bool) {
    if chains.is_empty() {
        println!(
            "✅ No multi-part recordings found (gap ≤{:.0} min, end→start ≤{:.0} m).",
            t.max_gap_min, t.max_dist_m
        );
        return;
    }
    let parts: usize = chains.iter().map(|c| c.parts.len()).sum();
    println!(
        "Found {} chain(s) covering {} part-recordings ({} rides after merge):\n",
        chains.len(),
        parts,
        chains.len()
    );
    let max_shown = 15;
    for (i, chain) in chains.iter().take(max_shown).enumerate() {
        let first = &chain.parts[0];
        let last = chain.parts.last().unwrap();
        println!(
            "Chain {} — {} parts, {} {} → {}",
            i + 1,
            chain.parts.len(),
            first.started_at.format("%Y-%m-%d"),
            first.started_at.format("%H:%M"),
            last.ended_at.format("%H:%M"),
        );
        let max_parts_shown = 6;
        for part in chain.parts.iter().take(max_parts_shown) {
            println!(
                "   {}–{} {}",
                part.started_at.format("%H:%M"),
                part.ended_at.format("%H:%M"),
                part.name.as_deref().unwrap_or("<unnamed>"),
            );
        }
        if chain.parts.len() > max_parts_shown {
            println!("   … and {} more part(s)", chain.parts.len() - max_parts_shown);
        }
    }
    if chains.len() > max_shown {
        println!("   … and {} more chain(s)", chains.len() - max_shown);
    }
    if !apply {
        println!("\nDry run — re-run with --apply to merge each chain into one ride.");
    }
}

/// Apply: insert one merged ride per chain, supersede the parts, shelve
/// their exported files.
pub async fn apply(
    pool: &PgPool,
    chains: &[Chain],
    dest: Option<&Path>,
) -> anyhow::Result<MergePartsSummary> {
    let mut summary = MergePartsSummary {
        chains: chains.len(),
        ..Default::default()
    };
    for chain in chains {
        match merge_chain(pool, chain, dest, &mut summary).await {
            Ok(()) => summary.rides_created += 1,
            Err(e) => {
                summary.chains_skipped += 1;
                warn!(
                    first_part = %chain.parts[0].id,
                    error = %e,
                    "Skipped chain — could not merge"
                );
            }
        }
    }
    Ok(summary)
}

async fn merge_chain(
    pool: &PgPool,
    chain: &Chain,
    dest: Option<&Path>,
    summary: &mut MergePartsSummary,
) -> anyhow::Result<()> {
    let ids: Vec<Uuid> = chain.parts.iter().map(|p| p.id).collect();
    let rows = sqlx::query(
        r#"
        SELECT id, file_id, original_name, source_format, started_at, ended_at,
               raw_time_series,
               has_heart_rate, has_cadence, has_power,
               fit_sport, fit_sub_sport, device_manufacturer, device_product,
               origin::text AS origin, mode::text AS mode, mode_source, area_id
        FROM rides WHERE id = ANY($1)
        "#,
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let mut by_id: HashMap<Uuid, sqlx::postgres::PgRow> =
        rows.into_iter().map(|r| (r.get::<Uuid, _>("id"), r)).collect();
    let parts: Vec<sqlx::postgres::PgRow> = ids
        .iter()
        .map(|id| {
            by_id
                .remove(id)
                .ok_or_else(|| anyhow::anyhow!("part {id} vanished mid-merge"))
        })
        .collect::<anyhow::Result<_>>()?;

    // Concatenate time series in part order, dropping points that don't
    // advance the clock across a part boundary (tiny overlaps happen when a
    // device restarts mid-fix).
    let mut merged: Vec<serde_json::Value> = Vec::new();
    let mut last_time: Option<DateTime<Utc>> = None;
    for part in &parts {
        let ts: serde_json::Value = part.get("raw_time_series");
        let arr = ts
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("raw_time_series is not an array"))?;
        for point in arr {
            let time = point
                .get("time")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.with_timezone(&Utc));
            if let (Some(t), Some(last)) = (time, last_time) {
                if t <= last {
                    continue;
                }
            }
            if time.is_some() {
                last_time = time;
            }
            merged.push(point.clone());
        }
    }
    if merged.len() < 2 {
        anyhow::bail!("merged time series has fewer than 2 points");
    }

    // 2D LineString from the merged points (same shape as ingest writes).
    let coords: Vec<String> = merged
        .iter()
        .map(|p| {
            let lon = p.get("lon").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let lat = p.get("lat").and_then(|v| v.as_f64()).unwrap_or(0.0);
            format!("[{lon}, {lat}]")
        })
        .collect();
    let geojson = format!(
        r#"{{"type": "LineString", "coordinates": [{}]}}"#,
        coords.join(", ")
    );

    // Mode from the longest part; a user-tagged part outranks auto ones.
    let dur = |r: &sqlx::postgres::PgRow| {
        let s: DateTime<Utc> = r.get("started_at");
        let e: DateTime<Utc> = r.get("ended_at");
        (e - s).num_seconds()
    };
    let user_tagged: Vec<&sqlx::postgres::PgRow> = parts
        .iter()
        .filter(|r| r.get::<String, _>("mode_source") == "user")
        .collect();
    let mode_donor = if user_tagged.is_empty() {
        parts.iter().max_by_key(|r| dur(r)).unwrap()
    } else {
        *user_tagged.iter().max_by_key(|r| dur(r)).unwrap()
    };
    let mode: String = mode_donor.get("mode");
    let mode_source: String = mode_donor.get("mode_source");

    let first = &parts[0];
    let started_at: DateTime<Utc> = first.get("started_at");
    let ended_at: DateTime<Utc> = parts.iter().map(|r| r.get::<DateTime<Utc>, _>("ended_at")).max().unwrap();
    let any = |col: &str| parts.iter().any(|r| r.get::<bool, _>(col));
    let first_some = |col: &str| {
        parts
            .iter()
            .find_map(|r| r.get::<Option<String>, _>(col))
    };

    let mut tx = pool.begin().await?;
    let merged_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO rides (
            id, file_id, name, original_name, track_type, source_format,
            started_at, ended_at,
            raw_geometry, raw_time_series,
            has_heart_rate, has_cadence, has_power,
            fit_sport, fit_sub_sport, device_manufacturer, device_product,
            origin, mode, mode_source, area_id
        )
        VALUES (
            $1, $2, NULL, $3, 'ride'::track_type, $4,
            $5, $6,
            ST_SetSRID(ST_GeomFromGeoJSON($7), 4326), $8,
            $9, $10, $11,
            $12, $13, $14, $15,
            $16::ride_origin, $17::ride_mode, $18, $19
        )
        "#,
    )
    .bind(merged_id)
    .bind(first.get::<Uuid, _>("file_id"))
    .bind(first.get::<Option<String>, _>("original_name"))
    .bind(first.get::<String, _>("source_format"))
    .bind(started_at)
    .bind(ended_at)
    .bind(&geojson)
    .bind(serde_json::Value::Array(merged))
    .bind(any("has_heart_rate"))
    .bind(any("has_cadence"))
    .bind(any("has_power"))
    .bind(first_some("fit_sport"))
    .bind(first_some("fit_sub_sport"))
    .bind(first_some("device_manufacturer"))
    .bind(first_some("device_product"))
    .bind(first.get::<String, _>("origin"))
    .bind(mode)
    .bind(mode_source)
    .bind(first.get::<Option<Uuid>, _>("area_id"))
    .execute(&mut *tx)
    .await?;

    // Supersede the parts and move their photos onto the merged ride, atomically
    // with creating it. exported_path is left intact here and cleared per-part
    // only after its file is shelved (below), so an interrupted move can't orphan
    // the GPX in the library tree.
    sqlx::query("UPDATE rides SET superseded_by = $1 WHERE id = ANY($2)")
        .bind(merged_id)
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE photos SET ride_id = $1 WHERE ride_id = ANY($2)")
        .bind(merged_id)
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    summary.parts_superseded += ids.len();

    if let Some(dest) = dest {
        for part in &chain.parts {
            let Some(rel) = part.exported_path.as_deref() else {
                continue;
            };
            let file = dest.join(rel);
            let clear_pointer = if file.exists() {
                match move_into(&file, &dest.join("Duplicates")) {
                    Ok(()) => {
                        summary.files_moved += 1;
                        true
                    }
                    Err(e) => {
                        warn!(file = %file.display(), error = %e, "Failed to shelve merged part");
                        false
                    }
                }
            } else {
                true
            };
            if clear_pointer {
                sqlx::query("UPDATE rides SET exported_path = NULL WHERE id = $1")
                    .bind(part.id)
                    .execute(pool)
                    .await?;
            }
        }
    }
    Ok(())
}
