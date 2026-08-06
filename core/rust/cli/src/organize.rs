//! `dingo organize` — process every GPX/FIT/ZIP under a source directory
//! (the Inbox) and keep the browsable GPX library on disk in sync.
//!
//! Flow:
//!   1. Recursively collect every loose `.gpx`/`.fit` and every `.zip`
//!      (Garmin exports, Strava exports incl. `.gz` activities) under the
//!      source dir and ingest them (idempotent — files already ingested are
//!      detected by content hash). The dest tree is skipped if it nests
//!      inside the source.
//!   2. `clean --all` then `name --rides-all` so every ride has cleaned
//!      geometry plus name + locality/endpoint attributes.
//!   3. Export the library tree (shared placement engine in `dingo_export::
//!      library` — one State/District/Region/LGA/Suburb hierarchy, owner and
//!      plan-vs-recorded as filename tags, non-loop tracks capped at their
//!      start/end common level).
//!   4. CONSUME the sources: the content-addressed hash store is the archive,
//!      so a source file whose bytes are verified present in the store is
//!      deleted from the load location. A file whose ingest failed — or a zip
//!      with any failed member — is left in place and reported: nothing is
//!      ever deleted that the store doesn't provably hold. Legacy
//!      `Duplicates/` and `Archives/` zone contents are absorbed the same way
//!      (their bytes were ingested when they were first organized), then the
//!      emptied zones are pruned.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use sqlx::PgPool;
use tracing::warn;

use dingo_core::Result;
use dingo_ingest::{FileStore, RideOrigin};

/// Counts from an organize run, for the final report.
#[derive(Debug, Default)]
pub struct OrganizeSummary {
    pub sources_ingested: usize,
    pub zips_processed: usize,
    pub rides_exported: usize,
    pub rides_already_exported: usize,
    /// Existing exported files regenerated in place (`--force`)
    pub rides_rewritten: usize,
    /// Already-exported files moved because the adaptive layout changed
    pub rides_relocated: usize,
    pub rides_skipped_no_geom: usize,
    /// Source zips consumed into the hash store
    pub files_archived: usize,
    /// Loose source files consumed into the hash store
    pub files_deduped: usize,
    /// A few example tree paths for eyeballing
    pub samples: Vec<String>,
}

/// Move a file into `dir`, creating it, and avoiding name collisions.
/// (Used by dedupe/merge tooling for shelving superseded library files.)
pub(crate) fn move_into(src: &Path, dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let name = src.file_name().unwrap_or_default();
    let mut dest = dir.join(name);
    if dest.exists() {
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
        let mut n = 2;
        loop {
            let cand = if ext.is_empty() {
                dir.join(format!("{stem} ({n})"))
            } else {
                dir.join(format!("{stem} ({n}).{ext}"))
            };
            if !cand.exists() {
                dest = cand;
                break;
            }
            n += 1;
        }
    }
    // rename() fails across filesystems; fall back to copy+remove.
    match fs::rename(src, &dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(src, &dest)?;
            fs::remove_file(src)
        }
    }
}

/// Source tag for a file under `src`: its first sub-directory component
/// (the Inbox/<source>/ convention — Inbox/wikiloc/x.gpx tags 'wikiloc').
/// Files directly in `src` get None.
fn source_of(src: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(src).ok()?;
    let mut comps = rel.components();
    let first = comps.next()?;
    // Only when the file is nested (first component is a directory)
    comps.next()?;
    Some(first.as_os_str().to_string_lossy().into_owned())
}

/// Recursively collect ingestable sources under `src` (deterministic order):
/// loose `.gpx`/`.fit` files and `.zip` archives, at any depth. The organized
/// tree itself (`dest`) is skipped if it nests inside `src`, so an Inbox that
/// lives next to (or the run that targets) the library never re-ingests its
/// own exports.
fn collect_sources(src: &Path, dest: &Path) -> std::io::Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    let skip = dest.canonicalize().ok();
    let mut loose: Vec<PathBuf> = Vec::new();
    let mut zips: Vec<PathBuf> = Vec::new();
    let mut stack = vec![src.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                let skipped = path
                    .canonicalize()
                    .ok()
                    .is_some_and(|p| Some(&p) == skip.as_ref());
                if !skipped {
                    stack.push(path);
                }
            } else if path.is_file() {
                match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
                    Some(e) if e == "gpx" || e == "fit" => loose.push(path),
                    Some(e) if e == "zip" => zips.push(path),
                    _ => {}
                }
            }
        }
    }
    loose.sort();
    zips.sort();
    Ok((loose, zips))
}

/// Verify-then-delete: (re)store the file's bytes content-addressed — a no-op
/// when already present — and delete the source only once the stored copy is
/// confirmed on disk. Returns whether the source was consumed.
/// (Shared with `dingo ingest`, which consumes sources the same way.)
pub(crate) fn consume_source(file_store: &FileStore, path: &Path) -> bool {
    match file_store.store(path) {
        Ok(stored) if stored.stored_path.exists() => match fs::remove_file(path) {
            Ok(()) => true,
            Err(e) => {
                warn!(file = %path.display(), error = %e, "stored but could not remove source");
                false
            }
        },
        Ok(_) => {
            warn!(file = %path.display(), "hash store write not visible — source kept");
            false
        }
        Err(e) => {
            warn!(file = %path.display(), error = %e, "could not store source — kept");
            false
        }
    }
}

/// Absorb the legacy `Duplicates/` and `Archives/` zones: every file there was
/// ingested when it was first organized, so verify its bytes into the hash
/// store and delete it. Unknown file types are left (and keep the folder).
fn absorb_legacy_zones(file_store: &FileStore, dest: &Path) {
    for zone in ["Duplicates", "Archives"] {
        let dir = dest.join(zone);
        if !dir.is_dir() {
            continue;
        }
        let mut stack = vec![dir.clone()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = fs::read_dir(&d) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if matches!(
                    path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref(),
                    Some("gpx" | "fit" | "zip" | "gz")
                ) {
                    consume_source(file_store, &path);
                }
            }
        }
        dingo_export::prune_empty_dirs(&dir);
        let _ = fs::remove_dir(&dir); // gone once fully absorbed
    }
}

/// Full organize run over a source directory. `force` rewrites the content
/// of already-exported GPX files (see `dingo_export::export_tree`).
pub async fn run(
    pool: &PgPool,
    file_store: &FileStore,
    src: &Path,
    dest: &Path,
    origin: RideOrigin,
    keep_sources: bool,
    force: bool,
) -> Result<OrganizeSummary> {
    let mut summary = OrganizeSummary::default();

    let (loose_files, zip_files) = collect_sources(src, dest)?;

    // --- Phase 1: ingest ---
    let mut failed_zips: HashSet<PathBuf> = HashSet::new();
    for zip in &zip_files {
        println!("📦 Ingesting archive: {}", zip.file_name().unwrap_or_default().to_string_lossy());
        // Zip ingest doesn't surface ride ids, so tag by an import watermark.
        // Read the mark from the DATABASE clock (not the host) so it can't
        // drift against imported_at's `now()` (audit M8). Caveat: a ride
        // imported by another process during this exact zip run with no source
        // would also be swept up — rare, and re-taggable.
        let mark: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT now()").fetch_one(pool).await?;
        match dingo_ingest::ingest_zip(pool, file_store, zip, origin).await {
            Ok(s) => {
                summary.zips_processed += 1;
                if let Some(tag) = source_of(src, zip) {
                    sqlx::query(
                        "UPDATE rides SET source = $1 WHERE imported_at >= $2 AND source IS NULL AND kind = 'recorded'",
                    )
                    .bind(&tag)
                    .bind(mark)
                    .execute(pool)
                    .await?;
                }
                println!(
                    "   imported {} / {} processed ({} dupes, {} skipped, {} failed)",
                    s.files_imported, s.files_processed,
                    s.files_skipped_duplicate, s.files_skipped_unsupported, s.files_failed
                );
                if s.files_failed > 0 {
                    // Some member wasn't captured as a ride — keep the zip.
                    failed_zips.insert(zip.clone());
                }
            }
            Err(e) => {
                warn!(zip = %zip.display(), error = %e, "Failed to ingest archive");
                failed_zips.insert(zip.clone());
            }
        }
    }
    let mut failed_sources: HashSet<PathBuf> = HashSet::new();
    for loose in &loose_files {
        match dingo_ingest::ingest_file(pool, file_store, loose, origin).await {
            Ok(res) => {
                summary.sources_ingested += 1;
                if let Some(tag) = source_of(src, loose) {
                    let ids: Vec<sqlx::types::Uuid> = res.ride_ids.iter().map(|r| r.0).collect();
                    sqlx::query("UPDATE rides SET source = $1 WHERE id = ANY($2)")
                        .bind(&tag)
                        .bind(&ids)
                        .execute(pool)
                        .await?;
                }
            }
            Err(e) => {
                warn!(file = %loose.display(), error = %e, "Failed to ingest file");
                failed_sources.insert(loose.clone());
            }
        }
    }

    // --- Phase 2: clean + name/locate everything ---
    println!("🧹 Cleaning rides...");
    let clean_cfg = dingo_geo::CleaningConfig::default();
    let cs = dingo_geo::clean_all_rides(pool, &clean_cfg).await?;
    println!("   cleaned {} of {} processed", cs.rides_cleaned, cs.rides_processed);

    if dingo_enrich::locality_count(pool).await.unwrap_or(0) > 0 {
        // Incremental: only new/unlocated rides get the (expensive) locality
        // sampling; the region backfill inside still fixes every ride.
        println!("🏷  Naming + locating new rides...");
        let ns = dingo_enrich::name_unlocated_rides(pool).await?;
        println!("   named {}", ns.rides_named);
    } else {
        warn!("Gazetteer empty — rides will export under Unknown; run `dingo gazetteer load`");
    }

    // --- Phase 3: export the library tree ---
    println!("🌳 Exporting library GPX tree to {}...", dest.display());
    let tree = dingo_export::export_tree(pool, dest, force)
        .await
        .map_err(|e| dingo_core::Error::Other(e.to_string()))?;
    summary.rides_exported = tree.rides_exported;
    summary.rides_already_exported = tree.rides_already_exported;
    summary.rides_rewritten = tree.rides_rewritten;
    summary.rides_relocated = tree.rides_relocated;
    summary.rides_skipped_no_geom = tree.rides_skipped_no_geom;
    summary.samples = tree.samples;

    // --- Phase 4: consume the sources (the hash store is the archive) ---
    if !keep_sources {
        for zip in &zip_files {
            if failed_zips.contains(zip) {
                warn!(zip = %zip.display(), "Left in place — not every member was captured");
                continue;
            }
            if consume_source(file_store, zip) {
                summary.files_archived += 1;
            }
        }
        for loose in &loose_files {
            // A file whose ingest failed is NOT captured as a ride — leave the
            // only copy where it is rather than deleting it.
            if failed_sources.contains(loose) {
                warn!(file = %loose.display(), "Left in place — ingest failed");
                continue;
            }
            if consume_source(file_store, loose) {
                summary.files_deduped += 1;
            }
        }
        absorb_legacy_zones(file_store, dest);
        dingo_export::prune_empty_dirs(src);
    }

    Ok(summary)
}
