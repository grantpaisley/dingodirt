//! The browsable GPX library tree — shared placement engine
//! (Docs/plans/2026-07-28-gpx-library-storage-design.md).
//!
//! ONE location hierarchy: State → District → Region → LGA → Suburb, where
//! District comes from the manually-curated `district_map` (unmapped regions
//! simply skip the level). Owner and plan-vs-recorded are NOT folders — they
//! are DB attributes surfaced as filename tags:
//!
//!   Womerah_Range_Circuit.gpx            your recording (unmarked)
//!   Womerah_Range_Circuit_(Macca).gpx    someone else's recording
//!   Six_Foot_Track_(wikiloc,_plan).gpx   an imported plan/route
//!
//! Levels are ADAPTIVE, as before: a folder divides by the first remaining
//! level that is meaningful (more than [`SPLIT_MIN_TRACKS`] tracks AND at
//! least two child groups over [`SPLIT_MIN_CHILD`]); "Unknown" values and
//! crumb groups fold into `Other/`.
//!
//! NEW: a non-loop track carries a *placement ceiling* — the deepest level at
//! which its start and end localities agree — and is never foldered deeper
//! than that: it lies loose where its whole journey fits (Palmdale→Kandos sits
//! in `NSW/`). Loops, and tracks whose endpoints were never resolved, keep
//! today's behaviour (placed by their start locality all the way down).
//!
//! The layout is recomputed from whole-library counts every run; files whose
//! folder changed are RELOCATED (renamed, not rewritten).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{build_ride_gpx, sanitize, sanitize_filename};

/// A folder only divides into subfolders when more than this many tracks live
/// below it…
const SPLIT_MIN_TRACKS: usize = 30;
/// …and the division is meaningful: at least two groups each hold more than
/// this many tracks (kills single-child and one-dominant-child splits).
const SPLIT_MIN_CHILD: usize = 10;
/// Within a split, groups holding this many tracks or fewer (plus all
/// "Unknown" values) fold into `Other/`; an Other that would itself hold this
/// few lies loose in the parent folder instead.
const FOLD_MAX: usize = 2;
/// Locality key levels per track: State → District → Region → LGA → Suburb.
const LEVELS: usize = 5;

/// Counts from a tree export, for the caller's report.
#[derive(Debug, Default)]
pub struct TreeSummary {
    pub rides_exported: usize,
    pub rides_already_exported: usize,
    /// Existing exported files regenerated in place (`force`)
    pub rides_rewritten: usize,
    /// Already-exported files moved because the layout changed
    pub rides_relocated: usize,
    pub rides_skipped_no_geom: usize,
    /// A few example tree paths for eyeballing
    pub samples: Vec<String>,
}

/// One track's placement inputs: its (sanitized) start locality key and how
/// deep it may be foldered.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TrackKey {
    key: Vec<String>,
    /// Number of leading levels this track may be grouped by (LEVELS = no cap)
    ceiling: usize,
}

/// Folded into `Other/` (or loose in the parent): unclassifiable values, and
/// crumb groups too small to be worth a directory of their own.
fn is_folded(name: &str, count: usize) -> bool {
    name == "Unknown" || count <= FOLD_MAX
}

/// How many leading levels a track may be grouped by.
///
/// Loops — and tracks whose endpoints were never resolved (`is_loop` NULL, or
/// every end value missing) — get the full depth. A non-loop descends only
/// while start and end agree on the (sanitized) value; a level absent on BOTH
/// sides is neutral (District for an unmapped state), but absent on one side
/// stops the descent — we can't confirm the whole journey fits below it.
fn placement_ceiling(
    is_loop: Option<bool>,
    start: &[Option<String>],
    end: &[Option<String>],
) -> usize {
    if is_loop.unwrap_or(true) || end.iter().all(Option::is_none) {
        return LEVELS;
    }
    let mut ceiling = 0;
    for i in 0..LEVELS {
        match (&start[i], &end[i]) {
            (None, None) => ceiling = i + 1,
            (Some(s), Some(e)) if sanitize(s) == sanitize(e) => ceiling = i + 1,
            _ => break,
        }
    }
    ceiling
}

/// The parenthesised filename tag carrying what folders no longer encode.
/// None (no tag) = the default case: one of Grant's own recordings.
pub fn ride_tag(
    owner_kind: Option<&str>,
    owner_name: Option<&str>,
    source: Option<&str>,
    origin: &str,
    is_plan: bool,
) -> Option<String> {
    let who = match (owner_kind, owner_name) {
        (Some("me"), _) => None,
        (_, Some(n)) => Some(n.to_string()),
        _ => source
            .map(str::to_string)
            .or_else(|| (origin == "other").then(|| "other".to_string())),
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(w) = who {
        parts.push(w);
    }
    if is_plan {
        parts.push("plan".to_string());
    }
    (!parts.is_empty()).then(|| format!("({})", parts.join(", ")))
}

/// Assign a directory (as path components under the library root) to every
/// track key, applying the adaptive rules — and pinning each track no deeper
/// than its ceiling: when a folder splits at a level a track may not descend,
/// the track stays loose in that folder.
fn assign_dirs(
    tracks: Vec<TrackKey>,
    level: usize,
    dir: Vec<String>,
    out: &mut HashMap<TrackKey, Vec<String>>,
) {
    let mut groups: Option<BTreeMap<String, Vec<TrackKey>>> = None;
    let mut lvl = level;
    if tracks.len() > SPLIT_MIN_TRACKS {
        while lvl < LEVELS {
            let mut g: BTreeMap<String, Vec<TrackKey>> = BTreeMap::new();
            for t in tracks.iter().filter(|t| t.ceiling > lvl) {
                g.entry(t.key[lvl].clone()).or_default().push(t.clone());
            }
            if g.values().filter(|v| v.len() > SPLIT_MIN_CHILD).count() >= 2 {
                groups = Some(g);
                break;
            }
            lvl += 1;
        }
    }

    let Some(groups) = groups else {
        // No level divides this folder meaningfully — everything lies flat.
        for t in tracks {
            out.insert(t, dir.clone());
        }
        return;
    };

    // Tracks that may not descend past the split level lie loose here.
    for t in tracks.iter().filter(|t| t.ceiling <= lvl) {
        out.insert(t.clone(), dir.clone());
    }

    let folded_total: usize = groups
        .iter()
        .filter(|(n, v)| is_folded(n, v.len()))
        .map(|(_, v)| v.len())
        .sum();
    for (name, members) in groups {
        if is_folded(&name, members.len()) {
            let mut d = dir.clone();
            if folded_total > FOLD_MAX {
                d.push("Other".to_string());
            }
            for t in members {
                out.insert(t, d.clone());
            }
        } else {
            let mut d = dir.clone();
            d.push(name);
            assign_dirs(members, lvl + 1, d, out);
        }
    }
}

/// A collision-free destination path for `<dir>/<base>.gpx`.
fn unique_path(dir: &Path, base: &str, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let mut candidate = dir.join(format!("{base}.gpx"));
    let mut n = 2;
    while taken.contains(&candidate) || candidate.exists() {
        candidate = dir.join(format!("{base}_{n}.gpx"));
        n += 1;
    }
    taken.insert(candidate.clone());
    candidate
}

/// Best-effort removal of now-empty directories under `root` (not `root`
/// itself), deepest-first.
pub fn prune_empty_dirs(root: &Path) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path.clone());
                stack.push(path);
            }
        }
    }
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for dir in dirs {
        let _ = fs::remove_dir(&dir); // fails (kept) unless empty
    }
}

/// Export every ride with cleaned geometry into the library tree.
///
/// `force` regenerates the GPX content of files that already exist (keeping
/// their path, or relocating first if the layout moved).
pub async fn export_tree(pool: &PgPool, dest: &Path, force: bool) -> anyhow::Result<TreeSummary> {
    let mut summary = TreeSummary::default();
    let rides = sqlx::query(
        r#"
        SELECT r.id, r.name, r.original_name, r.exported_path,
               r.state, dm.district, r.region, r.lgas[1] AS lga, r.suburbs[1] AS suburb,
               r.end_state, edm.district AS end_district, r.end_region, r.end_lga, r.end_suburb,
               r.is_loop,
               r.track_type::text AS track_type, r.source, r.origin::text AS origin,
               o.name AS owner_name, o.kind AS owner_kind
        FROM rides r
        LEFT JOIN district_map dm  ON dm.state  = r.state     AND dm.region  = r.region
        LEFT JOIN district_map edm ON edm.state = r.end_state AND edm.region = r.end_region
        LEFT JOIN owners o ON o.id = r.owner_id
        WHERE r.cleaned_geometry IS NOT NULL AND ST_NPoints(r.cleaned_geometry) >= 2
          AND r.superseded_by IS NULL
          -- Planned routes (kind = 'planned') carry cleaned geometry too, but
          -- they live in their collections, not the recorded-ride library tree.
          AND r.kind = 'recorded'
        ORDER BY r.started_at ASC NULLS LAST
        "#,
    )
    .fetch_all(pool)
    .await?;

    // Sanitized start key + ceiling per ride; adaptive rules assign the dirs.
    let track_of = |row: &sqlx::postgres::PgRow| -> TrackKey {
        let start: Vec<Option<String>> = ["state", "district", "region", "lga", "suburb"]
            .iter()
            .map(|c| row.get::<Option<String>, _>(*c))
            .collect();
        let end: Vec<Option<String>> =
            ["end_state", "end_district", "end_region", "end_lga", "end_suburb"]
                .iter()
                .map(|c| row.get::<Option<String>, _>(*c))
                .collect();
        TrackKey {
            key: start
                .iter()
                .map(|v| sanitize(v.as_deref().unwrap_or("Unknown")))
                .collect(),
            ceiling: placement_ceiling(row.get("is_loop"), &start, &end),
        }
    };

    let mut dir_of: HashMap<TrackKey, Vec<String>> = HashMap::new();
    assign_dirs(
        rides.iter().map(track_of).collect(),
        0,
        Vec::new(),
        &mut dir_of,
    );

    let mut taken: HashSet<PathBuf> = HashSet::new();
    // Reserve every existing exported file's path up front so a NEW ride
    // that sanitizes to the same name can't be assigned — and silently
    // overwrite — a file that belongs to another ride.
    for row in &rides {
        if let Some(rel) = row.get::<Option<String>, _>("exported_path") {
            let path = dest.join(rel);
            if path.exists() {
                taken.insert(path);
            }
        }
    }

    for row in &rides {
        let mut dir = dest.to_path_buf();
        for part in &dir_of[&track_of(row)] {
            dir = dir.join(part);
        }
        let ride_id: Uuid = row.get("id");
        let name: Option<String> = row.get("name");
        let name = name.as_deref().unwrap_or("Unnamed ride");

        let is_plan = row.get::<String, _>("track_type") == "route";
        let source: Option<String> = row.get("source");
        let owner_name: Option<String> = row.get("owner_name");
        let owner_kind: Option<String> = row.get("owner_kind");
        let origin: String = row.get("origin");
        let tag = ride_tag(
            owner_kind.as_deref(),
            owner_name.as_deref(),
            source.as_deref(),
            &origin,
            is_plan,
        );
        let base = sanitize_filename(&match &tag {
            Some(t) => format!("{name} {t}"),
            None => name.to_string(),
        });
        // The same facts ride inside the file, so they survive it leaving the
        // library.
        let desc = {
            let mut parts: Vec<String> = Vec::new();
            if let Some(o) = &owner_name {
                parts.push(format!("owner: {o}"));
            }
            if let Some(s) = &source {
                parts.push(format!("source: {s}"));
            }
            parts.push(format!("type: {}", if is_plan { "plan" } else { "recorded" }));
            if let Some(orig) = row.get::<Option<String>, _>("original_name") {
                parts.push(format!("original: {orig}"));
            }
            parts.join(" · ")
        };

        // Incremental: a ride whose exported file still exists is never
        // rewritten (unless `force`) — but if the layout moved its folder,
        // relocate it (picking up the current tagged filename).
        let exported: Option<String> = row.get("exported_path");
        if let Some(rel) = &exported {
            let current = dest.join(rel);
            if current.exists() {
                let target = if current.parent() == Some(dir.as_path()) {
                    current.clone()
                } else {
                    fs::create_dir_all(&dir)?;
                    unique_path(&dir, &base, &mut taken)
                };
                let moved = target != current;
                if force {
                    // Regenerate content at the existing path (the filename
                    // stays stable; the GPX metadata name tracks the DB).
                    match build_ride_gpx(pool, ride_id, name, None, false, Some(&desc)).await? {
                        crate::RideGpx::Gpx(gpx) => {
                            fs::write(&target, gpx)?;
                            if moved {
                                let _ = fs::remove_file(&current);
                            }
                            summary.rides_rewritten += 1;
                        }
                        _ => {
                            summary.rides_skipped_no_geom += 1;
                            continue;
                        }
                    }
                } else if moved {
                    fs::rename(&current, &target).or_else(|_| {
                        fs::copy(&current, &target).and_then(|_| fs::remove_file(&current))
                    })?;
                    summary.rides_relocated += 1;
                } else {
                    summary.rides_already_exported += 1;
                }
                if moved {
                    if let Ok(rel) = target.strip_prefix(dest) {
                        sqlx::query("UPDATE rides SET exported_path = $1 WHERE id = $2")
                            .bind(rel.to_string_lossy().as_ref())
                            .bind(ride_id)
                            .execute(pool)
                            .await?;
                    }
                }
                continue;
            }
        }

        let gpx = match build_ride_gpx(pool, ride_id, name, None, false, Some(&desc)).await? {
            crate::RideGpx::Gpx(g) => g,
            _ => {
                summary.rides_skipped_no_geom += 1;
                continue;
            }
        };

        fs::create_dir_all(&dir)?;
        let path = unique_path(&dir, &base, &mut taken);
        fs::write(&path, gpx)?;

        // Remember where this ride lives (relative, so the tree root can move).
        if let Ok(rel) = path.strip_prefix(dest) {
            sqlx::query("UPDATE rides SET exported_path = $1 WHERE id = $2")
                .bind(rel.to_string_lossy().as_ref())
                .bind(ride_id)
                .execute(pool)
                .await?;
        }

        summary.rides_exported += 1;
        if summary.samples.len() < 12 {
            if let Ok(rel) = path.strip_prefix(dest) {
                summary.samples.push(rel.display().to_string());
            }
        }
    }

    // Relocations leave husks behind — drop any now-empty folders (including
    // the retired Recorded/ and Plans/ zones after the one-time migration).
    prune_empty_dirs(dest);
    Ok(summary)
}

/// Export just the given rides into an existing library layout — the
/// export-on-import path. Runs the full layout computation (placement depends
/// on whole-library counts) but only touches files for `ride_ids`.
pub async fn place_rides(
    pool: &PgPool,
    dest: &Path,
    ride_ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, String>> {
    // The incremental branch of export_tree already skips every ride whose
    // exported file exists (unless the layout moved it), so a full pass IS the
    // targeted pass — plus it keeps sibling placements honest as counts grow.
    let _ = export_tree(pool, dest, false).await?;
    let mut placed = HashMap::new();
    if ride_ids.is_empty() {
        return Ok(placed);
    }
    let rows = sqlx::query("SELECT id, exported_path FROM rides WHERE id = ANY($1)")
        .bind(ride_ids)
        .fetch_all(pool)
        .await?;
    for r in rows {
        if let Some(p) = r.get::<Option<String>, _>("exported_path") {
            placed.insert(r.get("id"), p);
        }
    }
    Ok(placed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(vals: [&str; 5]) -> Vec<Option<String>> {
        vals.iter().map(|v| {
            if v.is_empty() { None } else { Some(v.to_string()) }
        }).collect()
    }

    #[test]
    fn ceiling_loop_and_unknown_end_uncapped() {
        let s = some(["NSW", "Central", "Central Coast", "Central Coast", "Palmdale"]);
        assert_eq!(placement_ceiling(Some(true), &s, &some(["", "", "", "", ""])), LEVELS);
        assert_eq!(placement_ceiling(None, &s, &s.clone()), LEVELS);
        // non-loop but endpoints never resolved
        assert_eq!(placement_ceiling(Some(false), &s, &some(["", "", "", "", ""])), LEVELS);
    }

    #[test]
    fn ceiling_stops_at_first_disagreement() {
        let s = some(["NSW", "Central", "Hunter", "Singleton", "Broke"]);
        // Hunter -> Central Coast: same state+district, different region
        let e = some(["NSW", "Central", "Central Coast", "Gosford", "Somersby"]);
        assert_eq!(placement_ceiling(Some(false), &s, &e), 2);
        // Palmdale -> Kandos: same state only
        let e2 = some(["NSW", "North", "Mudgee", "Mid-Western", "Kandos"]);
        assert_eq!(placement_ceiling(Some(false), &s, &e2), 1);
        // interstate
        let e3 = some(["QLD", "South", "South East Queensland", "Brisbane", "Brisbane"]);
        assert_eq!(placement_ceiling(Some(false), &s, &e3), 0);
    }

    #[test]
    fn ceiling_absent_level_is_neutral_both_sides_only() {
        // VIC has no districts: absent on both sides — keep descending
        let s = some(["VIC", "", "High Country", "Mansfield", "Jamieson"]);
        assert_eq!(placement_ceiling(Some(false), &s, &s.clone()), LEVELS);
        // absent on ONE side stops the descent
        let e = some(["VIC", "East", "High Country", "Mansfield", "Jamieson"]);
        assert_eq!(placement_ceiling(Some(false), &s, &e), 1);
    }

    #[test]
    fn tags_follow_owner_source_and_type() {
        // own recording: unmarked
        assert_eq!(ride_tag(Some("me"), Some("Grant"), None, "self", false), None);
        // own plan
        assert_eq!(
            ride_tag(Some("me"), Some("Grant"), None, "self", true),
            Some("(plan)".into())
        );
        // a mate's recording
        assert_eq!(
            ride_tag(Some("friend"), Some("Macca"), None, "other", false),
            Some("(Macca)".into())
        );
        // bulk source plan, owner unset -> source string
        assert_eq!(
            ride_tag(None, None, Some("wikiloc"), "other", true),
            Some("(wikiloc, plan)".into())
        );
        // other-origin with no owner or source still gets marked
        assert_eq!(ride_tag(None, None, None, "other", false), Some("(other)".into()));
        // unowned self recording: unmarked
        assert_eq!(ride_tag(None, None, None, "self", false), None);
    }

    #[test]
    fn split_pins_capped_tracks_loose_in_parent() {
        // 40 loop tracks across two suburbs force a suburb split; one
        // non-loop track capped at state level must lie loose at the root
        // (the split level exceeds its ceiling).
        let mk = |suburb: &str, ceiling: usize| TrackKey {
            key: vec![
                "NSW".into(),
                "Central".into(),
                "Central Coast".into(),
                "Central Coast".into(),
                suburb.into(),
            ],
            ceiling,
        };
        let mut tracks: Vec<TrackKey> = Vec::new();
        for _ in 0..20 {
            tracks.push(mk("Palmdale", LEVELS));
        }
        for _ in 0..20 {
            tracks.push(mk("Somersby", LEVELS));
        }
        let capped = TrackKey { ceiling: 1, ..mk("Palmdale", LEVELS) };
        tracks.push(capped.clone());

        let mut out = HashMap::new();
        assign_dirs(tracks, 0, Vec::new(), &mut out);

        // All keys identical through level 3, so the first meaningful split is
        // the suburb level; loops land in suburb folders...
        assert_eq!(out[&mk("Palmdale", LEVELS)], vec!["Palmdale".to_string()]);
        assert_eq!(out[&mk("Somersby", LEVELS)], vec!["Somersby".to_string()]);
        // ...while the state-capped track lies loose in the split folder.
        assert_eq!(out[&capped], Vec::<String>::new());
    }
}
