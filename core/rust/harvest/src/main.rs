//! dingo-harvest — heat tile harvester (Docs/plans/2026-07-12-heat-harvester-design.md).

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use dingo_harvest::{frontier, limiter::Window, worker};

#[derive(Parser)]
#[command(name = "dingo-harvest")]
#[command(about = "Slowly mirror heat tiles into local MBTiles archives")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage harvest regions (named bbox + zoom targets)
    #[command(subcommand)]
    Region(RegionCmd),
    /// Drain a region's frontier: fetch, measure, store, descend
    Run {
        /// Region name (see `region list`)
        region: String,
        /// Requests per second — keep it polite
        #[arg(long, default_value_t = 1.0)]
        rate: f64,
        /// Relative pacing jitter (0.3 = ±30%)
        #[arg(long, default_value_t = 0.3)]
        jitter: f64,
        /// Only fetch inside this local-time window, e.g. 22:00-06:00
        #[arg(long)]
        window: Option<String>,
        /// Stop after N fetches (testing / dipping a toe)
        #[arg(long)]
        limit: Option<u64>,
        /// Heat ratio at or below this is treated as empty (pruned)
        #[arg(long, default_value_t = 0.0)]
        min_heat_ratio: f64,
    },
    /// Frontier progress per zoom, plus archive size
    Status {
        /// Region name; omit for all regions
        region: Option<String>,
    },
    /// Put a region's failed tiles back in the queue
    RequeueFailed { region: String },
}

#[derive(Subcommand)]
enum RegionCmd {
    /// Create a region and seed its frontier
    Add {
        /// Unique region name, e.g. central-coast
        name: String,
        /// west,south,east,north (lon/lat)
        #[arg(long)]
        bbox: String,
        /// Deepest zoom to harvest (Strava heat tops out at 15)
        #[arg(long, default_value_t = 13)]
        target_zoom: u32,
        /// Zoom the descent seeds at
        #[arg(long, default_value_t = 6)]
        seed_zoom: u32,
    },
    /// Create a corridor region seeded from your own tracks: harvest z15 heat
    /// only along (and near) the trails you actually ride, not a whole bbox.
    AddCorridor {
        /// Unique region name, e.g. sydney-corridor
        name: String,
        /// west,south,east,north (lon/lat) — only rides inside are used
        #[arg(long)]
        bbox: String,
        /// Deepest zoom to harvest along the corridor (Strava tops out at 15)
        #[arg(long, default_value_t = 15)]
        zmax: u32,
        /// Shallowest corridor zoom (broad overview is a separate bbox region)
        #[arg(long, default_value_t = 14)]
        zmin: u32,
        /// Dilate the corridor by this many tiles each side (0 = tracks only)
        #[arg(long, default_value_t = 1)]
        ring: u32,
        /// Densify tracks to this spacing (deg) so long straights don't skip tiles
        #[arg(long, default_value_t = 0.004)]
        segmentize: f64,
    },
    /// List regions
    List,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    let config = dingo_core::Config::load().map_err(|e| anyhow::anyhow!("config: {e}"))?;
    let pool = dingo_core::db::create_pool(&config.database_url).await?;

    match cli.command {
        Commands::Region(RegionCmd::Add { name, bbox, target_zoom, seed_zoom }) => {
            let bbox = parse_bbox(&bbox)?;
            anyhow::ensure!(seed_zoom <= target_zoom, "seed_zoom must be <= target_zoom");
            anyhow::ensure!(target_zoom <= 15, "Strava heat tiles top out at z15");
            let owner = frontier::strava_owner(&pool).await?;
            let (region, seeded) =
                frontier::add_region(&pool, owner, &name, bbox, seed_zoom, target_zoom).await?;
            println!(
                "region {:?} created (z{}→z{}), {} seed tiles queued",
                region.name, seed_zoom, target_zoom, seeded
            );
            println!("start it with: dingo-harvest run {}", region.name);
        }
        Commands::Region(RegionCmd::AddCorridor {
            name,
            bbox,
            zmax,
            zmin,
            ring,
            segmentize,
        }) => {
            let bbox = parse_bbox(&bbox)?;
            anyhow::ensure!(zmin <= zmax, "zmin must be <= zmax");
            anyhow::ensure!(zmax <= 15, "Strava heat tiles top out at z15");
            let owner = frontier::strava_owner(&pool).await?;
            let (region, seeded) = frontier::add_corridor_region(
                &pool, owner, &name, bbox, zmin, zmax, ring, segmentize,
            )
            .await?;
            println!(
                "corridor region {:?} created (z{}→z{}, ring {}), {} tiles queued from your tracks",
                region.name, zmin, zmax, ring, seeded
            );
            println!("start it with: dingo-harvest run {}", region.name);
        }
        Commands::Region(RegionCmd::List) => {
            let regions = frontier::list_regions(&pool).await?;
            if regions.is_empty() {
                println!("no regions — add one with `dingo-harvest region add`");
            }
            for r in regions {
                println!(
                    "{}  z{}→z{}  bbox {:.3},{:.3},{:.3},{:.3}",
                    r.name, r.seed_zoom, r.target_zoom, r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]
                );
            }
        }
        Commands::Run { region, rate, jitter, window, limit, min_heat_ratio } => {
            let window = window.as_deref().map(Window::parse).transpose()?;
            let summary = worker::run(
                &pool,
                &region,
                worker::RunOpts { rate, jitter, window, limit, min_heat_ratio },
            )
            .await?;
            println!(
                "fetched {} — stored {}, empty {}, failed {}, newly queued {}",
                summary.fetched, summary.stored, summary.empty, summary.failed, summary.enqueued
            );
        }
        Commands::Status { region } => {
            let owner = frontier::strava_owner(&pool).await?;
            let regions = match region {
                Some(name) => vec![frontier::get_region(&pool, &name).await?],
                None => frontier::list_regions(&pool).await?,
            };
            for r in regions {
                println!("{}  (z{}→z{})", r.name, r.seed_zoom, r.target_zoom);
                let counts = frontier::status(&pool, owner, r.id).await?;
                if counts.is_empty() {
                    println!("  frontier empty — not seeded?");
                    continue;
                }
                for c in &counts {
                    println!("  z{:>2}  {:>8}  {:>7}", c.z, c.state, c.count);
                }
                let path = worker::mbtiles_path("Strava global", &r.name);
                if let Ok(meta) = std::fs::metadata(&path) {
                    println!(
                        "  archive: {} ({:.1} MB)",
                        path.display(),
                        meta.len() as f64 / 1_048_576.0
                    );
                }
            }
        }
        Commands::RequeueFailed { region } => {
            let owner = frontier::strava_owner(&pool).await?;
            let r = frontier::get_region(&pool, &region).await?;
            let n = frontier::requeue_failed(&pool, owner, r.id).await?;
            println!("{n} failed tiles requeued");
        }
    }
    Ok(())
}

fn parse_bbox(s: &str) -> Result<[f64; 4]> {
    let parts: Vec<f64> = s
        .split(',')
        .map(|p| p.trim().parse::<f64>().context("bbox values must be numbers"))
        .collect::<Result<_>>()?;
    anyhow::ensure!(parts.len() == 4, "bbox must be west,south,east,north");
    Ok([parts[0], parts[1], parts[2], parts[3]])
}
