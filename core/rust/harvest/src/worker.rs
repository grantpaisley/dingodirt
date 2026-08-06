//! The pruning descent: drain the frontier breadth-first, fetch each tile
//! politely, measure heat, store heat-bearing tiles, and descend only where
//! there is heat. Ocean/desert/empty jungle cost one fetch at low zoom, ever.

use anyhow::{Result, bail};
use sqlx::PgPool;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tracing::{info, warn};
use uuid::Uuid;

use crate::fetch::{Fetcher, Outcome};
use crate::frontier;
use crate::limiter::{TokenBucket, Window};
use crate::mbtiles::{MbtilesReader, MbtilesWriter};
use crate::tiles;

/// Give up on a tile after this many transient failures (requeueable later).
const MAX_ATTEMPTS: i32 = 5;
/// Progress log + MBTiles metadata checkpoint cadence.
const CHECKPOINT_EVERY: u64 = 25;

pub struct RunOpts {
    /// Requests per second (token bucket, capacity 1).
    pub rate: f64,
    /// Relative pacing jitter (0.3 = ±30%).
    pub jitter: f64,
    /// Only fetch inside this local-time window; sleep outside it.
    pub window: Option<Window>,
    /// Stop after this many fetches (handy for testing the pace).
    pub limit: Option<u64>,
    /// Tiles at or below this heat ratio are treated as empty.
    pub min_heat_ratio: f64,
}

#[derive(Debug, Default)]
pub struct Summary {
    pub fetched: u64,
    pub stored: u64,
    pub empty: u64,
    pub failed: u64,
    pub enqueued: u64,
}

/// The directory holding every owner's heat archives: `<file_store>/heat`.
pub fn heat_dir() -> PathBuf {
    dingo_core::Config::load()
        .map(|c| c.file_store_path)
        .unwrap_or_else(|_| PathBuf::from("./files"))
        .join("heat")
}

/// Where a region's archive lives: `<file_store>/heat/<owner>-<region>.mbtiles`.
pub fn mbtiles_path(owner_name: &str, region_name: &str) -> PathBuf {
    heat_dir().join(format!("{}-{}.mbtiles", slug(owner_name), slug(region_name)))
}

/// Slugify an owner/region name to its archive-filename form ("Strava global"
/// → "strava-global"). Public so the daemon can turn an owner into its file
/// prefix without re-implementing the rule.
pub fn name_slug(name: &str) -> String {
    slug(name)
}

/// Serve path: read one XYZ tile for an owner across all its region archives
/// (`<heat_dir>/<owner_slug>-*.mbtiles`), returning the first hit. Blocking I/O
/// — call from `spawn_blocking`. Ok(None) means "no such tile" (empty/unharvested).
pub fn read_owner_tile(owner_slug: &str, z: u32, x: u32, y: u32) -> Result<Option<Vec<u8>>> {
    let dir = heat_dir();
    let prefix = format!("{owner_slug}-");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(None), // no heat dir yet → nothing harvested
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(&prefix) || !name.ends_with(".mbtiles") {
            continue;
        }
        match MbtilesReader::open(&entry.path()).and_then(|r| r.tile(z, x, y)) {
            Ok(Some(bytes)) => return Ok(Some(bytes)),
            Ok(None) => {}
            // A single unreadable/locked archive shouldn't 500 the whole route.
            Err(e) => warn!(file = %name, error = %e, "heat archive read failed; skipping"),
        }
    }
    Ok(None)
}

fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Run the harvest for one region until its frontier drains (or a limit /
/// Ctrl-C / auth failure stops it). Restart-safe: all state is in Postgres.
pub async fn run(pool: &PgPool, region_name: &str, opts: RunOpts) -> Result<Summary> {
    // First Ctrl-C finishes the in-flight tile and exits cleanly; a second one
    // kills the process (state is still safe — the frontier is per-tile).
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                warn!("stop requested — finishing current tile");
                stop.store(true, Ordering::Relaxed);
            }
        });
    }
    run_with_stop(pool, region_name, opts, stop).await
}

/// Drain a region's frontier under a caller-owned `stop` flag, without
/// installing a Ctrl-C handler — so a long-lived process (the daemon's
/// auto-import harvest) can embed a run without hijacking process signals.
pub async fn run_with_stop(
    pool: &PgPool,
    region_name: &str,
    opts: RunOpts,
    stop: Arc<AtomicBool>,
) -> Result<Summary> {
    let owner_id = frontier::strava_owner(pool).await?;
    let region = frontier::get_region(pool, region_name).await?;
    let fetcher = Fetcher::new(pool).await?;

    let path = mbtiles_path("Strava global", &region.name);
    let writer = MbtilesWriter::open(
        &path,
        &format!("Strava global heat — {}", region.name),
        "Grayscale intensity tiles mirrored from the Strava global heatmap (personal offline archive)",
        region.bbox,
    )?;
    info!(region = %region.name, target_zoom = region.target_zoom,
          mbtiles = %path.display(), "harvest starting");

    let mut bucket = TokenBucket::new(opts.rate, opts.jitter);
    let mut summary = Summary::default();

    while !stop.load(Ordering::Relaxed) {
        if opts.limit.is_some_and(|limit| summary.fetched >= limit) {
            info!(limit = opts.limit, "fetch limit reached");
            break;
        }
        wait_for_window(&opts.window, &stop).await;
        if stop.load(Ordering::Relaxed) {
            break;
        }

        let Some((z, x, y, attempts)) =
            frontier::next_pending(pool, owner_id, region.id).await?
        else {
            info!("frontier drained — region complete at target zoom");
            break;
        };

        bucket.acquire().await;
        summary.fetched += 1;

        match fetcher.fetch(z, x, y).await {
            Outcome::Tile(bytes) => {
                let ratio = match crate::heat::heat_ratio(&bytes) {
                    Ok(r) => r,
                    Err(e) => {
                        // A 200 that isn't a decodable PNG is upstream weirdness;
                        // treat like a transient failure.
                        warn!(z, x, y, error = %e, "undecodable tile body");
                        handle_transient(pool, owner_id, region.id, (z, x, y), attempts, &mut summary)
                            .await?;
                        continue;
                    }
                };
                if ratio > opts.min_heat_ratio {
                    writer.put(z, x, y, &bytes)?;
                    frontier::mark(pool, owner_id, region.id, (z, x, y), "done", Some(ratio))
                        .await?;
                    summary.stored += 1;
                    if z < region.target_zoom {
                        // Descend — but only into children that still touch the
                        // region (a low-zoom seed tile can span far beyond it).
                        let kids: Vec<_> = tiles::children(z, x, y)
                            .into_iter()
                            .filter(|&(cz, cx, cy)| {
                                tiles::bbox_intersects(tiles::tile_bounds(cz, cx, cy), region.bbox)
                            })
                            .collect();
                        summary.enqueued +=
                            frontier::enqueue(pool, owner_id, region.id, &kids).await?;
                    }
                } else {
                    // Blank tile: prune — children are never enqueued.
                    frontier::mark(pool, owner_id, region.id, (z, x, y), "empty", Some(ratio))
                        .await?;
                    summary.empty += 1;
                }
            }
            Outcome::Missing => {
                frontier::mark(pool, owner_id, region.id, (z, x, y), "empty", Some(0.0)).await?;
                summary.empty += 1;
            }
            Outcome::AuthRejected(detail) => {
                // Stop hard: every further request would fail the same way.
                // The tile stays pending, so nothing is lost.
                bail!(
                    "Strava rejected authentication ({detail}) — refresh the CloudFront \
                     cookies (STRAVA_HEAT_COOKIES or the web UI's Strava connect panel) \
                     and re-run; the frontier resumes where it left off"
                );
            }
            Outcome::Transient(detail) => {
                warn!(z, x, y, attempt = attempts + 1, detail, "transient fetch failure");
                handle_transient(pool, owner_id, region.id, (z, x, y), attempts, &mut summary)
                    .await?;
            }
        }

        if summary.fetched % CHECKPOINT_EVERY == 0 {
            writer.refresh_zoom_meta()?;
            let pending = frontier::pending_count(pool, owner_id, region.id).await?;
            let (tiles_stored, bytes) = writer.stats()?;
            info!(
                fetched = summary.fetched,
                stored = summary.stored,
                empty = summary.empty,
                pending,
                archive_tiles = tiles_stored,
                archive_mb = format!("{:.1}", bytes as f64 / 1_048_576.0),
                "progress"
            );
        }
    }

    writer.refresh_zoom_meta()?;
    let (tiles_stored, bytes) = writer.stats()?;
    info!(
        fetched = summary.fetched,
        stored = summary.stored,
        empty = summary.empty,
        failed = summary.failed,
        enqueued = summary.enqueued,
        archive_tiles = tiles_stored,
        archive_mb = format!("{:.1}", bytes as f64 / 1_048_576.0),
        "harvest run finished"
    );
    Ok(summary)
}

/// Back off exponentially and either leave the tile pending or, after
/// MAX_ATTEMPTS, park it as failed and move on.
async fn handle_transient(
    pool: &PgPool,
    owner_id: Uuid,
    region_id: Uuid,
    coord: (u32, u32, u32),
    prev_attempts: i32,
    summary: &mut Summary,
) -> Result<()> {
    let attempts = frontier::bump_attempts(pool, owner_id, region_id, coord).await?;
    if attempts >= MAX_ATTEMPTS {
        sqlx::query!(
            r#"
            UPDATE harvest_frontier SET state = 'failed'
            WHERE owner_id = $1 AND region_id = $2 AND z = $3 AND x = $4 AND y = $5
            "#,
            owner_id,
            region_id,
            coord.0 as i32,
            coord.1 as i32,
            coord.2 as i32,
        )
        .execute(pool)
        .await?;
        summary.failed += 1;
        warn!(z = coord.0, x = coord.1, y = coord.2, attempts,
              "giving up on tile (requeue later with `dingo-harvest requeue-failed`)");
        return Ok(());
    }
    // 10s, 20s, 40s, 80s… capped at 5 min — polite even when upstream is angry.
    let backoff = Duration::from_secs((10u64 << prev_attempts.min(5) as u32).min(300));
    info!(backoff_s = backoff.as_secs(), "backing off");
    tokio::time::sleep(backoff).await;
    Ok(())
}

/// Sleep until we're inside the off-peak window (checking the stop flag).
async fn wait_for_window(window: &Option<Window>, stop: &AtomicBool) {
    let Some(w) = window else { return };
    let mut announced = false;
    while !w.contains(chrono::Local::now().time()) && !stop.load(Ordering::Relaxed) {
        if !announced {
            info!(window = %w, "outside off-peak window — sleeping");
            announced = true;
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::slug;

    #[test]
    fn slugs() {
        assert_eq!(slug("Strava global"), "strava-global");
        assert_eq!(slug("Central Coast (NSW)"), "central-coast-nsw");
    }
}
