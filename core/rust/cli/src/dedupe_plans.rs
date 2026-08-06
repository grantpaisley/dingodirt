//! `dingo dedupe-plans` — find near-identical plans (routes, `track_type =
//! 'route'`) by geometry and supersede all but one per cluster.
//!
//! Two plans count as "the same" when their Hausdorff distance is under a
//! metre threshold (default 100 m): every point of each track is within the
//! threshold of the other, so a plan with an extra 500 m spur does NOT match
//! its base version. Recorded rides are never touched — a plan and its later
//! recording are allowed to coexist.
//!
//! Report mode (default) prints clusters with the suggested keeper (most
//! points, then newest). `--apply` marks losers `superseded_by` the keeper
//! and, when their exported GPX is known, moves it into `<dest>/Duplicates/`.

use std::collections::HashMap;
use std::path::Path;

use sqlx::types::Uuid;
use sqlx::{PgPool, Row};
use tracing::warn;

use dingo_core::Result;

use crate::organize::move_into;

/// One plan involved in a duplicate cluster.
pub struct PlanEntry {
    pub id: Uuid,
    pub name: Option<String>,
    pub points: i32,
    pub exported_path: Option<String>,
}

/// A cluster of near-identical plans; `plans[0]` is the suggested keeper.
pub struct PlanCluster {
    pub plans: Vec<PlanEntry>,
    /// Largest pairwise Hausdorff distance within the cluster, metres.
    pub max_distance_m: f64,
}

#[derive(Debug, Default)]
pub struct DedupeSummary {
    pub clusters: usize,
    pub plans_superseded: usize,
    pub files_moved: usize,
}

/// Find clusters of plans whose geometries are within `threshold_m` of each
/// other (Hausdorff, web-mercator metres corrected for latitude).
pub async fn find_clusters(pool: &PgPool, threshold_m: f64) -> Result<Vec<PlanCluster>> {
    // Pairwise pass over live plans: bbox overlap prefilter (&&), then Hausdorff
    // on web-mercator geometry. 3857 metres are inflated by 1/cos(lat), so scale
    // back at the pair's centroid latitude. Note: wrapping both operands in
    // COALESCE means no GiST index serves the && here — acceptable because this
    // is plan-only (a few hundred routes), not the full ride set. A functional
    // GiST index on COALESCE(cleaned_geometry, raw_geometry) would fix it if
    // plan counts ever grow (future migration).
    let pairs = sqlx::query(
        r#"
        SELECT a.id AS id_a, b.id AS id_b,
               ST_HausdorffDistance(
                   ST_Transform(COALESCE(a.cleaned_geometry, a.raw_geometry), 3857),
                   ST_Transform(COALESCE(b.cleaned_geometry, b.raw_geometry), 3857)
               ) * cosd(ST_Y(ST_Centroid(COALESCE(a.cleaned_geometry, a.raw_geometry))))
                   AS dist_m
        FROM rides a
        JOIN rides b
          ON a.id < b.id
         AND COALESCE(a.cleaned_geometry, a.raw_geometry)
             && COALESCE(b.cleaned_geometry, b.raw_geometry)
        WHERE a.track_type = 'route' AND b.track_type = 'route'
          -- Curated planned routes (kind = 'planned') are never deduped — a
          -- collection's near-parallel variants are intentional.
          AND a.kind = 'recorded' AND b.kind = 'recorded'
          AND a.superseded_by IS NULL AND b.superseded_by IS NULL
          AND COALESCE(a.cleaned_geometry, a.raw_geometry) IS NOT NULL
          AND COALESCE(b.cleaned_geometry, b.raw_geometry) IS NOT NULL
        "#,
    )
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

    let mut matched: Vec<(Uuid, Uuid, f64)> = Vec::new();
    for row in &pairs {
        let dist: Option<f64> = row.get("dist_m");
        let Some(dist) = dist else { continue };
        if dist <= threshold_m {
            matched.push((row.get("id_a"), row.get("id_b"), dist));
        }
    }
    for &(a, b, _dist) in &matched {
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra != rb {
            parent.insert(ra, rb);
        }
    }

    // Group members by root.
    let mut groups: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let ids: Vec<Uuid> = parent.keys().copied().collect();
    for id in ids {
        let root = find(&mut parent, id);
        groups.entry(root).or_default().push(id);
    }

    // Load display data for every clustered plan.
    let all_ids: Vec<Uuid> = groups.values().flatten().copied().collect();
    if all_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        r#"
        SELECT id, name, exported_path,
               EXTRACT(EPOCH FROM imported_at)::float8 AS imported_epoch,
               ST_NPoints(COALESCE(cleaned_geometry, raw_geometry)) AS points
        FROM rides WHERE id = ANY($1)
        "#,
    )
    .bind(&all_ids)
    .fetch_all(pool)
    .await?;
    let mut info: HashMap<Uuid, (PlanEntry, f64)> = rows
        .into_iter()
        .map(|r| {
            let id: Uuid = r.get("id");
            let entry = PlanEntry {
                id,
                name: r.get("name"),
                points: r.get::<Option<i32>, _>("points").unwrap_or(0),
                exported_path: r.get("exported_path"),
            };
            (id, (entry, r.get::<Option<f64>, _>("imported_epoch").unwrap_or(0.0)))
        })
        .collect();

    let mut clusters: Vec<PlanCluster> = Vec::new();
    for (_, members) in groups {
        if members.len() < 2 {
            continue;
        }
        let mut plans: Vec<(PlanEntry, f64)> = members
            .iter()
            .filter_map(|id| info.remove(id))
            .collect();
        // Keeper first: most points, then newest import.
        plans.sort_by(|(a, ta), (b, tb)| {
            b.points
                .cmp(&a.points)
                .then(tb.partial_cmp(ta).unwrap_or(std::cmp::Ordering::Equal))
        });
        // True spread = farthest any cluster member is from the keeper, measured
        // directly. Folding only over directly-matched pairs (the old approach)
        // capped the reported distance at the threshold, hiding how far
        // transitively-chained plans (A↔B↔C, A–C never compared) really are.
        let keeper_id = plans[0].0.id;
        let other_ids: Vec<Uuid> = plans[1..].iter().map(|(e, _)| e.id).collect();
        let max_distance_m: f64 = sqlx::query_scalar::<_, Option<f64>>(
            r#"
            SELECT MAX(
                ST_HausdorffDistance(
                    ST_Transform(COALESCE(k.cleaned_geometry, k.raw_geometry), 3857),
                    ST_Transform(COALESCE(m.cleaned_geometry, m.raw_geometry), 3857)
                ) * cosd(ST_Y(ST_Centroid(COALESCE(k.cleaned_geometry, k.raw_geometry))))
            )
            FROM rides k CROSS JOIN rides m
            WHERE k.id = $1 AND m.id = ANY($2)
            "#,
        )
        .bind(keeper_id)
        .bind(&other_ids)
        .fetch_one(pool)
        .await?
        .unwrap_or(0.0);
        clusters.push(PlanCluster {
            plans: plans.into_iter().map(|(e, _)| e).collect(),
            max_distance_m,
        });
    }
    // Deterministic output order: by keeper name.
    clusters.sort_by(|a, b| a.plans[0].name.cmp(&b.plans[0].name));
    Ok(clusters)
}

/// Print the cluster report.
pub fn print_report(clusters: &[PlanCluster], threshold_m: f64, apply: bool) {
    if clusters.is_empty() {
        println!("✅ No near-duplicate plans found (threshold {threshold_m:.0} m).");
        return;
    }
    println!(
        "Found {} duplicate-plan cluster(s) (Hausdorff ≤ {threshold_m:.0} m):\n",
        clusters.len()
    );
    for (i, cluster) in clusters.iter().enumerate() {
        println!(
            "Cluster {} — {} plans, max spread {:.0} m",
            i + 1,
            cluster.plans.len(),
            cluster.max_distance_m
        );
        for (j, plan) in cluster.plans.iter().enumerate() {
            let marker = if j == 0 { "KEEP " } else { "  ↳  " };
            println!(
                "   {marker}{} ({} pts){}",
                plan.name.as_deref().unwrap_or("<unnamed>"),
                plan.points,
                plan.exported_path
                    .as_deref()
                    .map(|p| format!("  [{p}]"))
                    .unwrap_or_default()
            );
        }
    }
    if !apply {
        println!("\nDry run — re-run with --apply to supersede the non-keepers.");
    }
}

/// Apply: mark non-keepers superseded and shelve their exported files.
pub async fn apply(
    pool: &PgPool,
    clusters: &[PlanCluster],
    dest: Option<&Path>,
) -> Result<DedupeSummary> {
    let mut summary = DedupeSummary {
        clusters: clusters.len(),
        ..Default::default()
    };
    for cluster in clusters {
        let keeper = cluster.plans[0].id;
        for loser in &cluster.plans[1..] {
            sqlx::query(
                "UPDATE rides SET superseded_by = $1, exported_path = NULL WHERE id = $2",
            )
            .bind(keeper)
            .bind(loser.id)
            .execute(pool)
            .await?;
            summary.plans_superseded += 1;

            if let (Some(dest), Some(rel)) = (dest, loser.exported_path.as_deref()) {
                let file = dest.join(rel);
                if file.exists() {
                    match move_into(&file, &dest.join("Duplicates")) {
                        Ok(()) => summary.files_moved += 1,
                        Err(e) => {
                            warn!(file = %file.display(), error = %e, "Failed to shelve superseded plan")
                        }
                    }
                }
            }
        }
    }
    Ok(summary)
}
