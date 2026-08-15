use clap::{Parser, Subcommand};
use std::path::PathBuf;

mod dedupe_plans;
mod dedupe_rides;
mod export_offline;
mod merge_parts;
mod organize;
mod privacy;
mod strava_sync;

#[derive(Parser)]
#[command(name = "dingo")]
#[command(about = "A local-first trail knowledge system")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

/// CLI value for ride origin ('self' or 'other')
#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum OriginArg {
    /// Your own recordings (default)
    #[value(name = "self")]
    Self_,
    /// Someone else's tracks — renders red on the heatmap
    Other,
}

impl From<OriginArg> for dingo_ingest::RideOrigin {
    fn from(o: OriginArg) -> Self {
        match o {
            OriginArg::Self_ => dingo_ingest::RideOrigin::Own,
            OriginArg::Other => dingo_ingest::RideOrigin::Other,
        }
    }
}

#[derive(Subcommand)]
enum Commands {
    /// Ingest GPX/FIT files into the database; sources are consumed once
    /// their bytes are verified in the hash store (the store is the archive)
    Ingest {
        /// Path to file or directory to ingest
        path: PathBuf,
        /// Limit number of files to ingest (for testing)
        #[arg(long)]
        limit: Option<usize>,
        /// Scan and report only — no database writes, no file-store writes.
        /// Reports counts by format, date ranges, sport metadata, and
        /// suspected duplicates (exact-byte and time-window overlap).
        #[arg(long)]
        dry_run: bool,
        /// Whose tracks these are: 'self' (yours, default) or 'other'
        /// (someone else's — renders red on the heatmap)
        #[arg(long, value_enum, default_value_t = OriginArg::Self_)]
        origin: OriginArg,
        /// Leave source files where they are instead of consuming them
        #[arg(long)]
        keep_sources: bool,
    },
    /// Clean ride data (remove jitter, detect stops)
    Clean {
        /// Specific ride ID to clean
        #[arg(long)]
        ride: Option<String>,
        /// Clean all uncleaned rides
        #[arg(long)]
        all: bool,
    },
    /// Recompute turn cues (shared junction marks) from the roads table
    Turns {
        /// Specific ride ID
        #[arg(long)]
        ride: Option<String>,
        /// All rides with geometry
        #[arg(long)]
        all: bool,
        /// Limit to rides intersecting an area (UUID or name)
        #[arg(long)]
        area: Option<String>,
    },
    /// Enrich rides with weather and solar data
    Enrich {
        /// Specific ride ID to enrich
        #[arg(long)]
        ride: Option<String>,
        /// Enrich all unenriched rides
        #[arg(long)]
        all: bool,
    },
    /// Fill missing point elevations from the Terrarium DEM (routes + rides)
    ElevationBackfill,
    /// Name rides via the offline gazetteer
    Name {
        /// Generate names for all rides (offline gazetteer required)
        #[arg(long)]
        rides_all: bool,
    },
    /// Process all GPX/ZIP in a directory into the library GPX tree
    /// (State/District/Region/LGA/Suburb, owner + plan as filename tags);
    /// ingested source files are consumed (the hash store is the archive).
    Organize {
        /// Source directory to process (loose GPX + ZIP archives)
        #[arg(long)]
        src: PathBuf,
        /// Destination root for the organized tree
        #[arg(long)]
        dest: PathBuf,
        /// Whose tracks these are ('self' or 'other')
        #[arg(long, value_enum, default_value_t = OriginArg::Self_)]
        origin: OriginArg,
        /// Build the tree but don't move source files out of --src
        #[arg(long)]
        keep_sources: bool,
        /// Rewrite the content of already-exported GPX files (same paths) —
        /// use after the GPX writer itself changes
        #[arg(long)]
        force: bool,
    },
    /// Find near-identical plans (routes) by geometry and supersede all but
    /// one per cluster. Reports by default; --apply marks losers superseded
    /// and shelves their exported GPX into <dest>/Duplicates/.
    DedupePlans {
        /// Max Hausdorff distance in metres for two plans to count as the same
        #[arg(long, default_value_t = 100.0)]
        threshold_m: f64,
        /// Mark non-keepers superseded (and move files if --dest is given)
        #[arg(long)]
        apply: bool,
        /// Organized-library root (where Duplicates/ lives); used with --apply
        #[arg(long)]
        dest: Option<PathBuf>,
    },
    /// Find duplicate recordings (same start time + location + duration =
    /// THE SAME RIDE, e.g. Garmin archive vs Strava export of one recording)
    /// and supersede all but the best copy per cluster. Reports by default;
    /// --apply marks losers superseded and shelves their exported GPX.
    /// Re-run after merge-parts: merged rides can duplicate complete
    /// recordings that already existed.
    DedupeRides {
        /// Max metres between start points
        #[arg(long, default_value_t = 100.0)]
        start_m: f64,
        /// Max seconds between start times (separates re-exports of one
        /// recording from separate laps of the same loop later in the day)
        #[arg(long, default_value_t = 600.0)]
        start_time_s: f64,
        /// Max seconds of duration difference
        #[arg(long, default_value_t = 60.0)]
        duration_s: f64,
        /// Max percent difference in track length (sanity check)
        #[arg(long, default_value_t = 10.0)]
        length_pct: f64,
        /// Mark non-keepers superseded (and move files if --dest is given)
        #[arg(long)]
        apply: bool,
        /// Organized-library root (where Duplicates/ lives); used with --apply
        #[arg(long)]
        dest: Option<PathBuf>,
    },
    /// Stitch multi-part recordings back into single rides (early-days
    /// arbitrary splits): consecutive parts are chained when one ends where
    /// and when the next starts. Reports by default; --apply inserts one
    /// merged ride per chain and marks the parts superseded. Run
    /// `dingo clean --all` afterwards to clean + name the merged rides,
    /// then `dingo dedupe-rides` — a merged ride can duplicate a complete
    /// recording that already existed.
    MergeParts {
        /// Max minutes between one part ending and the next starting
        #[arg(long, default_value_t = 30.0)]
        max_gap_min: f64,
        /// Max metres between one part's end point and the next part's start
        #[arg(long, default_value_t = 500.0)]
        max_dist_m: f64,
        /// Insert merged rides and mark the parts superseded
        #[arg(long)]
        apply: bool,
        /// Organized-library root (where Duplicates/ lives); used with --apply
        #[arg(long)]
        dest: Option<PathBuf>,
    },
    /// Export data bundles for use outside Dingo
    Export {
        #[command(subcommand)]
        action: ExportAction,
    },
    /// Manage the offline locality gazetteer
    Gazetteer {
        #[command(subcommand)]
        action: GazetteerAction,
    },
    /// District groupings for the library tree (a level between State and
    /// Region, e.g. NSW / Mudgee -> "NSW North"); unmapped regions skip it
    District {
        #[command(subcommand)]
        action: DistrictAction,
    },
    /// Manage areas
    Area {
        #[command(subcommand)]
        action: AreaAction,
    },
    /// Ride mode classification
    Mode {
        #[command(subcommand)]
        action: ModeAction,
    },
    /// Import and match photos (Google Takeout)
    Photos {
        #[command(subcommand)]
        action: PhotosAction,
    },
    /// Privacy zones — polygons removed from every export that leaves Dingo
    Privacy {
        #[command(subcommand)]
        action: PrivacyAction,
    },
    /// Pull your own new Strava activities (see Docs/strava-sync.md)
    Strava {
        #[command(subcommand)]
        action: StravaAction,
    },
    /// Planned-route collections (curated networks like the G.O.A.T files)
    Routes {
        #[command(subcommand)]
        action: RoutesAction,
    },
}

#[derive(Subcommand)]
enum RoutesAction {
    /// Import a GPX route file as a planned-route collection: each track
    /// becomes a planned ride (no timings), waypoints become POIs
    Import {
        /// GPX file to import
        file: PathBuf,
        /// Collection label grouping this network (e.g. "GOAT NSW North")
        #[arg(long)]
        collection: String,
        /// Replace the collection if it already exists (the re-download path)
        #[arg(long)]
        replace: bool,
        /// Owner to assign to the planned rides: an owners.name (exact,
        /// case-insensitive) or an owners.id UUID
        #[arg(long)]
        owner: Option<String>,
    },
    /// List planned-route collections
    List,
}

#[derive(Subcommand)]
enum StravaAction {
    /// One-time OAuth connection (needs STRAVA_CLIENT_ID/SECRET in .env)
    Auth,
    /// Import activities newer than the newest ride in the DB
    Sync {
        /// Pull from this date instead (YYYY-MM-DD)
        #[arg(long)]
        since: Option<String>,
        /// Max activities to import this run
        #[arg(long, default_value_t = 200)]
        limit: usize,
    },
}

#[derive(Subcommand)]
enum PrivacyAction {
    /// Add a home-privacy circle (points inside are removed from exports).
    /// Auto-detects home from your ride start/end cluster, or pass --lat/--lon.
    AddHome {
        #[arg(long)]
        lat: Option<f64>,
        #[arg(long)]
        lon: Option<f64>,
        /// Circle radius in metres (default 300 — hides the exact address)
        #[arg(long, default_value_t = 300.0)]
        radius_m: f64,
        /// Zone name
        #[arg(long, default_value = "Home")]
        name: String,
    },
    /// Look up a place boundary (OSM/Nominatim) and store it as a zone,
    /// e.g. `dingo privacy add-place "Arcadia, New South Wales"`
    AddPlace {
        /// Free-text place query — suburbs/localities have boundaries
        query: String,
        /// Store under this name instead of OSM's display name
        #[arg(long)]
        name: Option<String>,
    },
    /// List stored zones
    List,
    /// Remove a zone by name
    Remove { name: String },
}

#[derive(Subcommand)]
enum ExportAction {
    /// Build an offline GPX bundle for a nav app (OsmAnd/Locus): merged
    /// per-class heatmap files plus one navigable file per plan, colored to
    /// match the web heatmap. Sync the output folder to the phone.
    Offline {
        /// Area to export (UUID or name); creates an <out>/<Area>/ subfolder
        #[arg(long)]
        area: Option<String>,
        /// Bounding box minLon,minLat,maxLon,maxLat (alternative to --area)
        #[arg(long)]
        bounds: Option<String>,
        /// Output directory for the bundle
        #[arg(long)]
        out: PathBuf,
        /// Simplification tolerance in metres for merged heatmap tracks
        /// (0 = full resolution; plans are always full resolution)
        #[arg(long, default_value_t = 5.0)]
        simplify_m: f64,
        /// Only include tracks of this mode (e.g. moto, mtb, gravel)
        #[arg(long)]
        mode: Option<String>,
        /// Personal-use escape hatch: keep privacy-zone points (exports are
        /// trimmed by default)
        #[arg(long)]
        no_privacy: bool,
    },
    /// Build a bundle from an explicit track selection (the same builder as
    /// the web UI's basket export): individual class-colored GPX per ride
    /// and/or merged heatmap layers built from the selection only.
    Bundle {
        /// File of ride UUIDs, one per line (alternative to --search)
        #[arg(long)]
        ids_from: Option<PathBuf>,
        /// Select rides by search query (same semantics as the web list
        /// search: terms AND'd over name/state/region/LGA/suburb)
        #[arg(long)]
        search: Option<String>,
        /// Write into this configured destination (see the web UI's export
        /// dialog, or POST /api/export/destinations)
        #[arg(long)]
        dest_name: Option<String>,
        /// Write into this directory (alternative to --dest-name)
        #[arg(long)]
        out: Option<PathBuf>,
        /// Bundle folder name (created under the destination)
        #[arg(long)]
        name: String,
        /// Skip the individual per-ride GPX files
        #[arg(long)]
        no_tracks: bool,
        /// Skip the merged heatmap layers
        #[arg(long)]
        no_heatmap: bool,
        /// Nav-app profile when --out is used (osmand | locus | dmd2 |
        /// generic); a --dest-name destination brings its own
        #[arg(long, default_value = "generic")]
        profile: String,
        /// Track-file layout: flat | tree (State/Region subfolders)
        #[arg(long, default_value = "flat")]
        layout: String,
        /// Personal-use escape hatch: keep privacy-zone points (exports are
        /// trimmed by default)
        #[arg(long)]
        no_privacy: bool,
    },
    /// Render the ride library into a raster density-heatmap MBTiles overlay
    /// (true Strava-style glow with per-pixel ride counts) for offline use in
    /// OsmAnd (tiles folder) or Locus (maps folder).
    HeatmapTiles {
        /// Output .mbtiles path (replaced if it exists)
        #[arg(long)]
        out: PathBuf,
        /// Area to render (UUID or name); default is the whole library
        #[arg(long)]
        area: Option<String>,
        /// Bounding box minLon,minLat,maxLon,maxLat (alternative to --area)
        #[arg(long)]
        bounds: Option<String>,
        /// Lowest zoom level to render
        #[arg(long, default_value_t = 5)]
        min_zoom: u32,
        /// Highest zoom level to render (each +1 roughly quadruples tiles)
        #[arg(long, default_value_t = 14)]
        max_zoom: u32,
        /// Only include tracks of this mode (e.g. moto, mtb, gravel)
        #[arg(long)]
        mode: Option<String>,
        /// Distinct-ride count that saturates to white-hot
        #[arg(long, default_value_t = 15.0)]
        hot_at: f64,
        /// Personal-use escape hatch: keep privacy-zone geometry (exports are
        /// trimmed by default)
        #[arg(long)]
        no_privacy: bool,
    },
}

#[derive(Subcommand)]
enum PhotosAction {
    /// Import photos from an extracted Google Takeout directory
    Import {
        /// Path to the extracted Takeout directory (or any folder of photos
        /// with Takeout JSON sidecars)
        path: PathBuf,
        /// Limit number of photos to import (for testing)
        #[arg(long)]
        limit: Option<usize>,
    },
    /// Match imported photos to rides (time window + GPS proximity)
    Match,
}

#[derive(Subcommand)]
enum ModeAction {
    /// Re-run mode classification over all cleaned rides (skips user overrides)
    Reclassify {
        /// Reclassify all rides
        #[arg(long)]
        all: bool,
    },
}

#[derive(Subcommand)]
enum DistrictAction {
    /// Map a region to a district (insert or update)
    Set {
        /// State the region belongs to (e.g. NSW)
        state: String,
        /// Region name as stored on rides (e.g. Mudgee)
        region: String,
        /// District folder the region groups under (e.g. "NSW North")
        district: String,
    },
    /// Remove a region's district mapping
    Rm { state: String, region: String },
    /// List all district mappings
    List,
}

#[derive(Subcommand)]
enum GazetteerAction {
    /// Load a gazetteer TSV (suburb, lga, state, lat, lng) into the localities table
    Load {
        /// Path to gazetteer file (e.g. data/gazetteer-au.tsv)
        path: PathBuf,
    },
    /// Load an LGA->region TSV (state, lga, region) into the lga_regions table
    LoadRegions {
        /// Path to regions file (e.g. data/lga-regions-au.tsv)
        path: PathBuf,
    },
    /// Load named roads from an OSM PBF extract (Geofabrik) into the roads table
    LoadRoads {
        /// Path to extract (e.g. australia-latest.osm.pbf)
        path: PathBuf,
    },
    /// Show gazetteer status
    Status,
}

#[derive(Subcommand)]
enum AreaAction {
    /// Create a new area
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        boundary: PathBuf,
        /// Parent area ID (optional)
        #[arg(long)]
        parent: Option<String>,
        /// Mode affinity (mtb, gravel, road)
        #[arg(long)]
        mode: Option<String>,
    },
    /// List all areas
    List,
    /// Show area details
    Show {
        /// Area ID
        id: String,
    },
    /// Assign rides to areas
    Assign {
        /// Assign all rides without an area
        #[arg(long)]
        all: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive("dingo=info".parse()?),
        )
        .init();

    let cli = Cli::parse();

    // Dry-run ingest never touches the database or file store — handle it
    // before creating the pool so it works even with the DB down.
    if let Commands::Ingest {
        path,
        limit,
        dry_run: true,
        ..
    } = &cli.command
    {
        println!("🔎 Dry-run scan: {} (no writes)", path.display());
        let report = dingo_ingest::dry_run_scan(path, *limit)?;
        report.print();
        return Ok(());
    }

    // Load config (defaults + DINGO_* / DATABASE_URL env overrides)
    let config = dingo_core::Config::load().map_err(|e| anyhow::anyhow!(e.to_string()))?;

    // Connect to database
    let pool = dingo_core::db::create_pool(&config.database_url).await?;

    match cli.command {
        Commands::Ingest {
            path,
            limit,
            dry_run: _,
            origin,
            keep_sources,
        } => {
            let origin: dingo_ingest::RideOrigin = origin.into();
            // Create file store
            let file_store = dingo_ingest::FileStore::new(&config.file_store_path)?;

            if path.is_file() {
                // Check if it's a zip file
                let is_zip = path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("zip"));

                if is_zip {
                    // Zip file ingest (handles Garmin exports and generic zips)
                    if let Some(n) = limit {
                        println!("📦 Processing zip file: {} (limit: {n})", path.display());
                    } else {
                        println!("📦 Processing zip file: {}", path.display());
                    }
                    let summary =
                        dingo_ingest::ingest_zip_limited(&pool, &file_store, &path, limit, origin)
                            .await?;

                    println!("\n📊 Zip Ingest Summary:");
                    println!("   Activities processed: {}", summary.files_processed);
                    println!("   Activities imported:  {}", summary.files_imported);
                    println!("   Tracks created:       {}", summary.tracks_created);
                    if summary.files_skipped_duplicate > 0 {
                        println!(
                            "   Skipped (duplicate):  {}",
                            summary.files_skipped_duplicate
                        );
                    }
                    if summary.files_skipped_unsupported > 0 {
                        println!(
                            "   Skipped (no GPS):     {}",
                            summary.files_skipped_unsupported
                        );
                    }
                    if summary.files_failed > 0 {
                        println!("   Failed:               {}", summary.files_failed);
                    }

                    // Consume the zip only when every member was captured —
                    // a failed member or a --limit cut-off means the zip
                    // still holds data the store doesn't.
                    if !keep_sources {
                        if summary.files_failed > 0 {
                            println!("   Source kept — not every member was captured");
                        } else if limit.is_some() {
                            println!("   Source kept — --limit stopped before the end");
                        } else if organize::consume_source(&file_store, &path) {
                            println!("   Source consumed (bytes archived in the hash store)");
                        }
                    }
                } else {
                    // Single file ingest
                    match dingo_ingest::ingest_file(&pool, &file_store, &path, origin).await {
                        Ok(result) => {
                            if result.was_duplicate {
                                println!(
                                    "⏭️  Skipped (duplicate): {}",
                                    path.file_name().unwrap_or_default().to_string_lossy()
                                );
                            } else {
                                println!(
                                    "✅ Imported: {} ({} track{})",
                                    path.file_name().unwrap_or_default().to_string_lossy(),
                                    result.track_count,
                                    if result.track_count == 1 { "" } else { "s" }
                                );
                            }
                            // Either way the bytes are in the store — consume.
                            if !keep_sources && organize::consume_source(&file_store, &path) {
                                println!("   Source consumed (bytes archived in the hash store)");
                            }
                        }
                        Err(e) => {
                            eprintln!("❌ Failed to ingest {}: {}", path.display(), e);
                            std::process::exit(1);
                        }
                    }
                }
            } else if path.is_dir() {
                // Directory ingest
                let summary =
                    dingo_ingest::ingest_directory(&pool, &file_store, &path, origin, limit)
                        .await?;

                println!("\n📊 Ingest Summary:");
                println!("   Files processed: {}", summary.files_processed);
                println!("   Files imported:  {}", summary.files_imported);
                println!("   Tracks created:  {}", summary.tracks_created);
                if summary.files_skipped_duplicate > 0 {
                    println!("   Skipped (dupe):  {}", summary.files_skipped_duplicate);
                }
                if summary.files_failed > 0 {
                    println!("   Failed:          {}", summary.files_failed);
                }

                // Consume sources whose bytes the store provably holds; failed
                // or unparseable files stay put — never delete the only copy.
                if !keep_sources {
                    let consumed = summary
                        .sources_ok
                        .iter()
                        .filter(|p| organize::consume_source(&file_store, p))
                        .count();
                    if consumed > 0 {
                        println!("   Consumed:        {consumed} (bytes archived in the hash store)");
                    }
                }
            } else {
                eprintln!("❌ Path does not exist: {}", path.display());
                std::process::exit(1);
            }
        }
        Commands::Organize {
            src,
            dest,
            origin,
            keep_sources,
            force,
        } => {
            let origin: dingo_ingest::RideOrigin = origin.into();
            let file_store = dingo_ingest::FileStore::new(&config.file_store_path)?;

            if !src.is_dir() {
                eprintln!("❌ Source is not a directory: {}", src.display());
                std::process::exit(1);
            }
            std::fs::create_dir_all(&dest)?;

            let summary =
                organize::run(&pool, &file_store, &src, &dest, origin, keep_sources, force)
                    .await?;

            println!("\n✅ Organize Complete:");
            println!("   Archives ingested:  {}", summary.zips_processed);
            println!("   Loose GPX ingested: {}", summary.sources_ingested);
            println!("   Rides exported:     {}", summary.rides_exported);
            if summary.rides_already_exported > 0 {
                println!("   Already in tree:    {}", summary.rides_already_exported);
            }
            if summary.rides_rewritten > 0 {
                println!("   Rewritten (force):  {}", summary.rides_rewritten);
            }
            if summary.rides_relocated > 0 {
                println!("   Relocated (layout): {}", summary.rides_relocated);
            }
            if summary.rides_skipped_no_geom > 0 {
                println!("   Skipped (no geom):  {}", summary.rides_skipped_no_geom);
            }
            if !keep_sources {
                println!("   Zips consumed:      {}", summary.files_archived);
                println!("   Loose consumed:     {}", summary.files_deduped);
            }
            if !summary.samples.is_empty() {
                println!("\n   Sample tree paths:");
                for s in &summary.samples {
                    println!("   • {s}");
                }
            }
        }
        Commands::DedupePlans {
            threshold_m,
            apply,
            dest,
        } => {
            let clusters = dedupe_plans::find_clusters(&pool, threshold_m).await?;
            dedupe_plans::print_report(&clusters, threshold_m, apply);
            if apply && !clusters.is_empty() {
                if dest.is_none() {
                    println!("⚠️  No --dest given — superseding in DB only, exported files stay put.");
                }
                let s = dedupe_plans::apply(&pool, &clusters, dest.as_deref()).await?;
                println!(
                    "\n✅ Superseded {} plan(s) across {} cluster(s); {} file(s) → Duplicates/",
                    s.plans_superseded, s.clusters, s.files_moved
                );
            }
        }
        Commands::DedupeRides {
            start_m,
            start_time_s,
            duration_s,
            length_pct,
            apply,
            dest,
        } => {
            let t = dedupe_rides::Thresholds { start_m, start_time_s, duration_s, length_pct };
            let clusters = dedupe_rides::find_clusters(&pool, &t).await?;
            dedupe_rides::print_report(&clusters, &t, apply);
            if apply && !clusters.is_empty() {
                if dest.is_none() {
                    println!("⚠️  No --dest given — superseding in DB only, exported files stay put.");
                }
                let s = dedupe_rides::apply(&pool, &clusters, dest.as_deref()).await?;
                println!(
                    "\n✅ Superseded {} recording(s) across {} cluster(s); {} file(s) → Duplicates/",
                    s.rides_superseded, s.clusters, s.files_moved
                );
            }
        }
        Commands::MergeParts {
            max_gap_min,
            max_dist_m,
            apply,
            dest,
        } => {
            let t = merge_parts::Thresholds { max_gap_min, max_dist_m };
            let chains = merge_parts::find_chains(&pool, &t).await?;
            merge_parts::print_report(&chains, &t, apply);
            if apply && !chains.is_empty() {
                if dest.is_none() {
                    println!("⚠️  No --dest given — superseding in DB only, exported files stay put.");
                }
                let s = merge_parts::apply(&pool, &chains, dest.as_deref()).await?;
                println!(
                    "\n✅ Merged {} chain(s): {} ride(s) created, {} part(s) superseded; {} file(s) → Duplicates/",
                    s.chains - s.chains_skipped, s.rides_created, s.parts_superseded, s.files_moved
                );
                if s.chains_skipped > 0 {
                    println!("⚠️  {} chain(s) skipped (see warnings above).", s.chains_skipped);
                }
                println!("→ Run `dingo clean --all` to clean + name the merged rides.");
            }
        }
        Commands::Strava { action } => match action {
            StravaAction::Auth => strava_sync::auth().await?,
            StravaAction::Sync { since, limit } => {
                let file_store = dingo_ingest::FileStore::new(&config.file_store_path)?;
                strava_sync::sync(&pool, &file_store, since.as_deref(), limit).await?;
            }
        },
        Commands::Routes { action } => match action {
            RoutesAction::Import {
                file,
                collection,
                replace,
                owner,
            } => {
                let file_store = dingo_ingest::FileStore::new(&config.file_store_path)?;
                let owner = match owner.as_deref() {
                    Some(spec) => Some(resolve_owner(&pool, spec).await?),
                    None => None,
                };
                let result = dingo_ingest::import_routes(
                    &pool,
                    &file_store,
                    &file,
                    &collection,
                    replace,
                    owner.as_ref().map(|(id, _)| *id),
                )
                .await?;
                if let Some((_, name)) = &owner {
                    println!("👤 Owner: {name}");
                }
                if result.replaced != (0, 0) {
                    println!(
                        "♻️  Replaced {} routes, {} POIs in \"{}\"",
                        result.replaced.0, result.replaced.1, result.collection
                    );
                }
                println!(
                    "✅ Imported \"{}\": {} planned routes, {} POIs",
                    result.collection, result.routes_created, result.pois_created
                );
                // Locality (state/region/LGAs) for Places + search — names
                // are untouched. Best-effort: an empty gazetteer just skips.
                match dingo_enrich::locate_planned_rides(&pool).await {
                    Ok(n) if n > 0 => println!("📍 Located {n} planned routes"),
                    Ok(_) => {}
                    Err(e) => println!("⚠️  Locality pass skipped: {e}"),
                }
            }
            RoutesAction::List => {
                let rows = sqlx::query_as::<_, (String, i64, Option<f64>)>(
                    r#"
                    SELECT collection, count(*),
                           SUM(ST_Length(cleaned_geometry::geography)) / 1000.0
                    FROM rides
                    WHERE kind = 'planned' AND collection IS NOT NULL
                    GROUP BY collection ORDER BY collection
                    "#,
                )
                .fetch_all(&pool)
                .await?;
                let pois = sqlx::query_as::<_, (String, i64)>(
                    "SELECT collection, count(*) FROM pois WHERE collection IS NOT NULL GROUP BY collection",
                )
                .fetch_all(&pool)
                .await?;
                let poi_counts: std::collections::HashMap<_, _> = pois.into_iter().collect();
                if rows.is_empty() {
                    println!("No planned-route collections.");
                }
                for (name, routes, km) in rows {
                    println!(
                        "{name}: {routes} routes, {} POIs, {:.0} km",
                        poi_counts.get(&name).copied().unwrap_or(0),
                        km.unwrap_or(0.0)
                    );
                }
            }
        },
        Commands::Privacy { action } => match action {
            PrivacyAction::AddHome { lat, lon, radius_m, name } => {
                privacy::add_home(&pool, lat, lon, radius_m, &name).await?;
            }
            PrivacyAction::AddPlace { query, name } => {
                privacy::add_place(&pool, &query, name.as_deref()).await?;
            }
            PrivacyAction::List => privacy::list(&pool).await?,
            PrivacyAction::Remove { name } => privacy::remove(&pool, &name).await?,
        },
        Commands::Export { action } => match action {
            ExportAction::Offline {
                area,
                bounds,
                out,
                simplify_m,
                mode,
                no_privacy,
            } => {
                let scope = match (&area, &bounds) {
                    (Some(_), Some(_)) => {
                        eprintln!("❌ Use --area or --bounds, not both");
                        std::process::exit(1);
                    }
                    (Some(a), None) => {
                        let (id, name) = export_offline::resolve_area(&pool, a).await?;
                        println!("🗺  Exporting offline bundle for area: {name}");
                        export_offline::Scope::Area { id, name }
                    }
                    (None, Some(b)) => {
                        let bbox = export_offline::parse_bounds(b)?;
                        println!("🗺  Exporting offline bundle for bounds: {b}");
                        export_offline::Scope::Bounds(bbox)
                    }
                    (None, None) => {
                        println!("🗺  Exporting offline bundle for ALL tracks");
                        export_offline::Scope::All
                    }
                };

                let summary =
                    export_offline::run(&pool, &out, &scope, simplify_m, mode.as_deref(), !no_privacy).await?;

                println!("\n✅ Offline bundle: {}", summary.dest.display());
                if summary.own_tracks > 0 {
                    println!("   heatmap_own.gpx:   {} tracks (orange)", summary.own_tracks);
                }
                if summary.other_tracks > 0 {
                    println!("   heatmap_other.gpx: {} tracks (red)", summary.other_tracks);
                }
                if summary.plan_tracks > 0 {
                    println!("   heatmap_plan.gpx:  {} tracks (blue)", summary.plan_tracks);
                }
                if summary.plan_files > 0 {
                    println!("   Plans/:            {} files (blue)", summary.plan_files);
                }
                if summary.route_files > 0 {
                    println!("   Routes/:           {} planned routes (own colors)", summary.route_files);
                }
                if summary.poi_count > 0 {
                    println!("   POIs.gpx:          {} waypoints", summary.poi_count);
                }
                if summary.skipped_no_geom > 0 {
                    println!("   Skipped (no geom): {}", summary.skipped_no_geom);
                }
                if summary.own_tracks + summary.other_tracks + summary.plan_tracks
                    + summary.plan_files + summary.route_files + summary.poi_count
                    == 0
                {
                    println!("   ⚠️  Nothing matched the given area/bounds/mode filters");
                } else {
                    println!("   Total size:        {:.1} MB", summary.total_bytes as f64 / 1_048_576.0);
                    println!("\n   Sync this folder to the phone, e.g. OsmAnd:");
                    println!("   Android/media/net.osmand.plus/files/tracks/");
                }
            }
            ExportAction::Bundle {
                ids_from,
                search,
                dest_name,
                out,
                name,
                no_tracks,
                no_heatmap,
                profile,
                layout,
                no_privacy,
            } => {
                use sqlx::Row as _;

                // --- Resolve the ride selection ---
                let ride_ids: Vec<sqlx::types::Uuid> = match (&ids_from, &search) {
                    (Some(_), Some(_)) | (None, None) => {
                        eprintln!("❌ Use exactly one of --ids-from or --search");
                        std::process::exit(1);
                    }
                    (Some(path), None) => std::fs::read_to_string(path)?
                        .lines()
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                        .map(|l| {
                            sqlx::types::Uuid::parse_str(l)
                                .map_err(|e| anyhow::anyhow!("bad UUID '{l}': {e}"))
                        })
                        .collect::<anyhow::Result<Vec<_>>>()?,
                    (None, Some(q)) => {
                        // Same semantics as the web list search: every term a
                        // case-insensitive substring over name + localities.
                        let terms: Vec<String> =
                            q.split_whitespace().map(|t| t.to_string()).collect();
                        sqlx::query(
                            r#"
                            SELECT id FROM rides
                            WHERE superseded_by IS NULL
                              AND cleaned_geometry IS NOT NULL
                              AND (SELECT bool_and(
                                       concat_ws(' ', name, state, region,
                                                 array_to_string(lgas, ' '),
                                                 array_to_string(suburbs, ' '))
                                       ILIKE '%' || t || '%')
                                   FROM unnest($1::text[]) t)
                            ORDER BY started_at ASC NULLS LAST
                            "#,
                        )
                        .bind(&terms)
                        .fetch_all(&pool)
                        .await?
                        .into_iter()
                        .map(|r| r.get("id"))
                        .collect()
                    }
                };
                if ride_ids.is_empty() {
                    eprintln!("❌ Selection matched no rides");
                    std::process::exit(1);
                }
                println!("📦 Bundling {} tracks…", ride_ids.len());

                // --- Resolve the destination ---
                let (dest_dir, profile, layout) = match (&dest_name, &out) {
                    (Some(_), Some(_)) | (None, None) => {
                        eprintln!("❌ Use exactly one of --dest-name or --out");
                        std::process::exit(1);
                    }
                    (Some(dn), None) => {
                        let row = sqlx::query(
                            "SELECT path, profile, layout FROM export_destinations \
                             WHERE lower(name) = lower($1)",
                        )
                        .bind(dn)
                        .fetch_optional(&pool)
                        .await?;
                        let Some(row) = row else {
                            eprintln!("❌ No destination named '{dn}' (create one in the web export dialog)");
                            std::process::exit(1);
                        };
                        (
                            PathBuf::from(row.get::<String, _>("path")),
                            row.get::<String, _>("profile"),
                            row.get::<String, _>("layout"),
                        )
                    }
                    (None, Some(o)) => (o.clone(), profile.clone(), layout.clone()),
                };

                let opts = dingo_export::BundleOptions {
                    include_tracks: !no_tracks,
                    include_heatmap: !no_heatmap,
                    profile: dingo_export::Profile::parse(&profile).unwrap_or_else(|| {
                        eprintln!("❌ Unknown profile '{profile}' (osmand | locus | dmd2 | generic)");
                        std::process::exit(1);
                    }),
                    layout: dingo_export::Layout::parse(&layout).unwrap_or_else(|| {
                        eprintln!("❌ Unknown layout '{layout}' (flat | tree)");
                        std::process::exit(1);
                    }),
                    simplify_m: None,
                    privacy: !no_privacy,
                };
                let bundle_dir = dest_dir.join(dingo_export::sanitize(&name));
                let manifest =
                    dingo_export::build_bundle(&pool, &ride_ids, &bundle_dir, &opts).await?;

                println!("\n✅ Bundle: {}", bundle_dir.display());
                let tracks = manifest.files.iter().filter(|f| f.kind == "track").count();
                if tracks > 0 {
                    println!("   Individual tracks: {tracks}");
                }
                for f in manifest.files.iter().filter(|f| f.kind == "heatmap") {
                    println!("   {}: {} tracks", f.path, f.rides);
                }
                if !manifest.skipped.is_empty() {
                    println!("   Skipped: {}", manifest.skipped.len());
                }
                println!(
                    "   Total size: {:.1} MB",
                    manifest.total_bytes as f64 / 1_048_576.0
                );
            }
            ExportAction::HeatmapTiles {
                out,
                area,
                bounds,
                min_zoom,
                max_zoom,
                mode,
                hot_at,
                no_privacy,
            } => {
                use dingo_export::heat_tiles::{HeatScope, HeatTilesOptions, build_heat_mbtiles};

                let scope = match (&area, &bounds) {
                    (Some(_), Some(_)) => {
                        eprintln!("❌ Use --area or --bounds, not both");
                        std::process::exit(1);
                    }
                    (Some(a), None) => {
                        let (id, name) = export_offline::resolve_area(&pool, a).await?;
                        println!("🔥 Rendering heatmap tiles for area: {name}");
                        HeatScope::Area(id)
                    }
                    (None, Some(b)) => {
                        let bbox = export_offline::parse_bounds(b)?;
                        println!("🔥 Rendering heatmap tiles for bounds: {b}");
                        HeatScope::Bounds(bbox)
                    }
                    (None, None) => {
                        println!("🔥 Rendering heatmap tiles for ALL tracks");
                        HeatScope::All
                    }
                };

                let opts = HeatTilesOptions {
                    scope,
                    min_zoom,
                    max_zoom,
                    mode_filter: mode,
                    hot_at,
                    privacy: !no_privacy,
                };
                let summary = build_heat_mbtiles(&pool, &out, &opts, |z, done, total| {
                    println!("   z{z}: {done}/{total} tiles");
                })
                .await?;

                println!("\n✅ Heatmap tiles: {}", out.display());
                println!("   Tracks rendered: {}", summary.rides);
                println!("   Tiles (z{min_zoom}-{max_zoom}): {}", summary.tiles);
                println!("   Tile data: {:.1} MB", summary.bytes as f64 / 1_048_576.0);
                println!("\n   Install as a raster overlay:");
                println!("   OsmAnd: Android/media/net.osmand.plus/files/tiles/");
                println!("   Locus:  Locus/mapsRaster/ (add as overlay in Maps)");
            }
        },
        Commands::Clean { ride, all } => {
            let cleaning_config = dingo_geo::CleaningConfig::default();

            if let Some(ride_id_str) = ride {
                // Clean a single ride
                let ride_id = dingo_core::RideId::parse(&ride_id_str)?;
                match dingo_geo::clean_ride(&pool, ride_id, &cleaning_config).await {
                    Ok(result) => {
                        println!(
                            "✅ Cleaned ride {}: {} → {} points ({:.1}% reduction), {} stops detected",
                            result.ride_id,
                            result.original_points,
                            result.cleaned_points,
                            100.0
                                * (1.0
                                    - result.cleaned_points as f64 / result.original_points as f64),
                            result.stops_detected
                        );
                    }
                    Err(e) => {
                        eprintln!("❌ Failed to clean ride: {e}");
                        std::process::exit(1);
                    }
                }
            } else if all {
                // Clean all uncleaned rides
                let summary = dingo_geo::clean_all_rides(&pool, &cleaning_config).await?;

                println!("\n📊 Cleaning Summary:");
                println!("   Rides processed: {}", summary.rides_processed);
                println!("   Rides cleaned:   {}", summary.rides_cleaned);
                if summary.rides_skipped > 0 {
                    println!("   Rides skipped:   {}", summary.rides_skipped);
                }
                if summary.rides_failed > 0 {
                    println!("   Rides failed:    {}", summary.rides_failed);
                }
                println!("   Points reduced:  {}", summary.total_points_reduced);
                println!("   Stops detected:  {}", summary.total_stops_detected);

                // Auto-name newly cleaned rides (no-op re-generation for the
                // rest; skipped entirely when the gazetteer isn't loaded)
                if summary.rides_cleaned > 0
                    && dingo_enrich::locality_count(&pool).await.unwrap_or(0) > 0
                {
                    let naming = dingo_enrich::name_all_rides(&pool).await?;
                    println!("   Rides named:     {}", naming.rides_named);
                }
            } else {
                eprintln!("Please specify --ride <ID> or --all");
                std::process::exit(1);
            }
        }
        Commands::Turns { ride, all, area } => {
            if !dingo_geo::turns::roads_available(&pool).await? {
                eprintln!("⚠️  Roads table empty — run: dingo gazetteer load-roads <australia.osm.pbf>");
                std::process::exit(1);
            }
            let ids: Vec<sqlx::types::Uuid> = if let Some(ride_id_str) = ride {
                vec![dingo_core::RideId::parse(&ride_id_str)?.0]
            } else if all || area.is_some() {
                let area_clause = match &area {
                    Some(arg) => {
                        let (id, name) = export_offline::resolve_area(&pool, arg).await?;
                        println!("🗺  Area: {name}");
                        format!(
                            "AND ST_Intersects(COALESCE(cleaned_geometry, raw_geometry), (SELECT boundary FROM areas WHERE id = '{id}'))"
                        )
                    }
                    None => String::new(),
                };
                let sql = format!(
                    "SELECT id FROM rides
                     WHERE COALESCE(cleaned_geometry, raw_geometry) IS NOT NULL {area_clause}
                     ORDER BY imported_at"
                );
                sqlx::query_scalar::<_, sqlx::types::Uuid>(&sql).fetch_all(&pool).await?
            } else {
                eprintln!("Please specify --ride <ID>, --all, or --area <name>");
                std::process::exit(1);
            };

            println!("🔀 Computing turn cues for {} rides...", ids.len());
            let mut cues = 0usize;
            let mut marks = 0usize;
            let mut failed = 0usize;
            for (i, id) in ids.iter().enumerate() {
                match dingo_geo::turns::recompute_ride_turns(&pool, dingo_core::RideId::from_uuid(*id)).await {
                    Ok(s) => {
                        cues += s.cues;
                        marks += s.marks_created;
                    }
                    Err(e) => {
                        failed += 1;
                        eprintln!("❌ {id}: {e}");
                    }
                }
                if (i + 1) % 250 == 0 {
                    println!("   {} / {} rides...", i + 1, ids.len());
                }
            }
            println!("\n📊 Turn cues:");
            println!("   Rides processed: {}", ids.len() - failed);
            println!("   Cues linked:     {cues}");
            println!("   Junctions added: {marks}");
            if failed > 0 {
                println!("   Rides failed:    {failed}");
            }
        }
        Commands::ElevationBackfill => {
            let summary = dingo_enrich::backfill_elevation(&pool).await?;
            println!("\n⛰️  Elevation backfill:");
            println!("   Rides processed: {}", summary.rides_processed);
            println!("   Rides filled:    {}", summary.rides_filled);
            println!("   Points filled:   {}", summary.points_filled);
            if summary.rides_failed > 0 {
                println!("   Rides failed:    {}", summary.rides_failed);
            }
        }
        Commands::Enrich { ride, all } => {
            if let Some(ride_id_str) = ride {
                // Enrich a single ride
                let ride_id = dingo_core::RideId::parse(&ride_id_str)?;
                match dingo_enrich::enrich_ride(&pool, ride_id).await {
                    Ok(result) => {
                        let weather_info = match &result.weather {
                            Some(w) => {
                                let mm = |v: Option<f32>| {
                                    v.map_or("?".to_string(), |x| format!("{x:.1}mm"))
                                };
                                let c = |v: Option<f32>| {
                                    v.map_or("?".to_string(), |x| format!("{x:.1}"))
                                };
                                format!(
                                    "precip 24h: {}, 48h: {}, temp: {}–{}°C",
                                    mm(w.precip_24h),
                                    mm(w.precip_48h),
                                    c(w.temp_min),
                                    c(w.temp_max)
                                )
                            }
                            None => "weather unavailable".to_string(),
                        };
                        println!(
                            "✅ Enriched ride {}: {:?} / {:?} ({:?}) — {}",
                            result.ride_id,
                            result.time_of_day,
                            result.condition.condition,
                            result.condition.confidence,
                            weather_info
                        );
                    }
                    Err(e) => {
                        eprintln!("❌ Failed to enrich ride: {e}");
                        std::process::exit(1);
                    }
                }
            } else if all {
                // Enrich all unenriched rides
                let summary = dingo_enrich::enrich_all_rides(&pool).await?;

                println!("\n📊 Enrichment Summary:");
                println!("   Rides processed: {}", summary.rides_processed);
                println!("   Rides enriched:  {}", summary.rides_enriched);
                if summary.rides_skipped > 0 {
                    println!("   Rides skipped:   {}", summary.rides_skipped);
                }
                if summary.rides_failed > 0 {
                    println!("   Rides failed:    {}", summary.rides_failed);
                }
                if summary.weather_errors > 0 {
                    println!("   Weather errors:  {}", summary.weather_errors);
                }
            } else {
                eprintln!("Please specify --ride <ID> or --all");
                std::process::exit(1);
            }
        }
        Commands::Name { rides_all } => {
            if !rides_all {
                eprintln!("❌ Please specify --rides-all");
                std::process::exit(1);
            }
            println!("🏷  Generating ride names (offline gazetteer)...");
            let summary = dingo_enrich::name_all_rides(&pool).await?;

            println!("\n✅ Ride Naming Complete:");
            println!("   Processed:      {}", summary.rides_processed);
            println!("   Named:          {}", summary.rides_named);
            println!("   User renames:   {} (skipped)", summary.rides_skipped_user);
            if summary.rides_failed > 0 {
                println!("   Failed:         {}", summary.rides_failed);
            }
            if !summary.samples.is_empty() {
                println!("\n   Samples:");
                for s in &summary.samples {
                    println!("   • {s}");
                }
            }
        }
        Commands::Gazetteer { action } => match action {
            GazetteerAction::Load { path } => {
                println!("🌏 Loading gazetteer from {}...", path.display());
                let loaded = dingo_enrich::load_gazetteer(&pool, &path).await?;
                let total = dingo_enrich::locality_count(&pool).await?;
                println!("✅ Loaded {loaded} localities ({total} total)");
            }
            GazetteerAction::LoadRegions { path } => {
                println!("🌏 Loading LGA regions from {}...", path.display());
                let loaded = dingo_enrich::load_regions(&pool, &path).await?;
                println!("✅ Loaded {loaded} LGA->region mappings");
            }
            GazetteerAction::LoadRoads { path } => {
                println!("🛣  Loading roads from {} (two PBF scans, takes a few minutes)...", path.display());
                let loaded = dingo_enrich::load_roads(&pool, &path).await?;
                println!("✅ Loaded {loaded} named roads");
            }
            GazetteerAction::Status => {
                let total = dingo_enrich::locality_count(&pool).await?;
                if total == 0 {
                    println!("⚠️  Gazetteer empty — run: dingo gazetteer load data/gazetteer-au.tsv");
                } else {
                    println!("🌏 {total} localities loaded");
                }
                let roads = dingo_enrich::roads_count(&pool).await?;
                if roads == 0 {
                    println!("⚠️  Roads empty (turn cues disabled) — run: dingo gazetteer load-roads <australia.osm.pbf>");
                } else {
                    println!("🛣  {roads} named roads loaded");
                }
            }
        },
        Commands::District { action } => match action {
            DistrictAction::Set { state, region, district } => {
                sqlx::query(
                    "INSERT INTO district_map (state, region, district) VALUES ($1, $2, $3)
                     ON CONFLICT (state, region) DO UPDATE SET district = EXCLUDED.district",
                )
                .bind(&state)
                .bind(&region)
                .bind(&district)
                .execute(&pool)
                .await?;
                println!("✅ {state} / {region} → {district}");
            }
            DistrictAction::Rm { state, region } => {
                let res = sqlx::query("DELETE FROM district_map WHERE state = $1 AND region = $2")
                    .bind(&state)
                    .bind(&region)
                    .execute(&pool)
                    .await?;
                if res.rows_affected() == 0 {
                    println!("⚠️  No mapping for {state} / {region}");
                } else {
                    println!("✅ Removed {state} / {region}");
                }
            }
            DistrictAction::List => {
                use sqlx::Row as _;
                let rows = sqlx::query(
                    "SELECT state, region, district FROM district_map
                     ORDER BY state, district, region",
                )
                .fetch_all(&pool)
                .await?;
                if rows.is_empty() {
                    println!("No district mappings — add one: dingo district set NSW Mudgee \"NSW North\"");
                }
                for r in rows {
                    println!(
                        "{} / {} → {}",
                        r.get::<String, _>("state"),
                        r.get::<String, _>("region"),
                        r.get::<String, _>("district")
                    );
                }
            }
        },
        Commands::Area { action } => match action {
            AreaAction::Create {
                name,
                boundary,
                parent,
                mode,
            } => {
                // Read GeoJSON from file
                let geojson_content = std::fs::read_to_string(&boundary)?;

                // Parse to extract just the geometry
                let geojson: serde_json::Value = serde_json::from_str(&geojson_content)?;

                // Handle both Feature and FeatureCollection formats
                let geometry = if let Some(features) = geojson.get("features") {
                    // FeatureCollection - take first feature's geometry
                    features
                        .get(0)
                        .and_then(|f| f.get("geometry"))
                        .ok_or_else(|| anyhow::anyhow!("No features found in GeoJSON"))?
                        .to_string()
                } else if geojson.get("geometry").is_some() {
                    // Feature format
                    geojson
                        .get("geometry")
                        .ok_or_else(|| anyhow::anyhow!("No geometry found in Feature"))?
                        .to_string()
                } else if geojson.get("type").and_then(|t| t.as_str()) == Some("Polygon") {
                    // Raw Polygon geometry
                    geojson.to_string()
                } else {
                    return Err(anyhow::anyhow!(
                        "Unsupported GeoJSON format. Expected Polygon, Feature, or FeatureCollection"
                    ));
                };

                let parent_id = match parent {
                    Some(p) => Some(dingo_core::AreaId::parse(&p)?),
                    None => None,
                };

                let area_id = dingo_core::area::create_area(
                    &pool,
                    &name,
                    &geometry,
                    parent_id,
                    mode.as_deref(),
                )
                .await?;

                println!("✅ Created area '{name}' with ID {area_id}");
            }
            AreaAction::List => {
                let areas = dingo_core::area::list_areas(&pool).await?;

                if areas.is_empty() {
                    println!("No areas defined yet.");
                    println!(
                        "Create one with: dingo area create --name <NAME> --boundary <GEOJSON>"
                    );
                } else {
                    println!("📍 Areas:\n");
                    for area_stats in &areas {
                        let indent = "  ".repeat(area_stats.area.depth as usize);
                        let mode_str = area_stats
                            .area
                            .mode_affinity
                            .as_ref()
                            .map(|m| format!(" [{m}]"))
                            .unwrap_or_default();
                        println!(
                            "{}{} ({}){} - {} rides",
                            indent,
                            area_stats.area.name,
                            area_stats.area.id,
                            mode_str,
                            area_stats.ride_count
                        );
                    }
                }
            }
            AreaAction::Show { id } => {
                let area_id = dingo_core::AreaId::parse(&id)?;
                let area = dingo_core::area::get_area(&pool, area_id).await?;

                match area {
                    Some(a) => {
                        println!("📍 Area: {}", a.name);
                        println!("   ID: {}", a.id);
                        if let Some(parent) = a.parent_id {
                            println!("   Parent: {parent}");
                        }
                        if let Some(mode) = &a.mode_affinity {
                            println!("   Mode: {mode}");
                        }
                        println!("   Depth: {}", a.depth);
                        println!("   Created: {}", a.created_at.format("%Y-%m-%d %H:%M"));

                        // Get ride count
                        let areas = dingo_core::area::list_areas(&pool).await?;
                        if let Some(stats) = areas.iter().find(|s| s.area.id == area_id) {
                            println!("   Rides: {}", stats.ride_count);
                        }
                    }
                    None => {
                        eprintln!("❌ Area not found: {id}");
                        std::process::exit(1);
                    }
                }
            }
            AreaAction::Assign { all } => {
                if all {
                    let summary =
                        dingo_core::area_service::assign_all_rides_to_areas(&pool).await?;

                    println!("\n📊 Assignment Summary:");
                    println!("   Rides processed: {}", summary.rides_processed);
                    println!("   Rides assigned:  {}", summary.rides_assigned);
                    if summary.rides_no_area > 0 {
                        println!("   No matching area: {}", summary.rides_no_area);
                    }
                    if summary.rides_skipped > 0 {
                        println!("   Skipped:         {}", summary.rides_skipped);
                    }
                    if summary.rides_failed > 0 {
                        println!("   Failed:          {}", summary.rides_failed);
                    }
                } else {
                    eprintln!("Please specify --all to assign all unassigned rides");
                    std::process::exit(1);
                }
            }
        },
        Commands::Mode { action } => match action {
            ModeAction::Reclassify { all } => {
                if !all {
                    eprintln!("Specify --all to reclassify all rides");
                    std::process::exit(1);
                }
                println!("🏍  Reclassifying ride modes (FIT metadata + speed signature)...");
                let summary = dingo_geo::reclassify_all_modes(&pool).await?;

                let fmt = |dist: &[(String, i64)]| {
                    dist.iter()
                        .map(|(m, c)| format!("{m}: {c}"))
                        .collect::<Vec<_>>()
                        .join("  ")
                };
                println!("\n📊 Reclassification Summary:");
                println!("   Rides processed:  {}", summary.rides_processed);
                println!("   Rides changed:    {}", summary.rides_changed);
                println!("   User overrides:   {} (skipped)", summary.rides_skipped_user);
                println!("   Failed:           {}", summary.rides_failed);
                println!("   Before:  {}", fmt(&summary.before));
                println!("   After:   {}", fmt(&summary.after));
            }
        },
        Commands::Photos { action } => match action {
            PhotosAction::Import { path, limit } => {
                if !path.is_dir() {
                    eprintln!("Not a directory: {} (unzip the Takeout archive first)", path.display());
                    std::process::exit(1);
                }
                println!("📷 Importing photos from: {}", path.display());
                let summary =
                    dingo_google::import_takeout(&pool, &config.photo_store_path, &path, limit)
                        .await?;

                println!("\n📊 Photo Import Summary:");
                println!("   Scanned:              {}", summary.scanned);
                println!("   Imported:             {}", summary.imported);
                println!("   Skipped (duplicate):  {}", summary.duplicates);
                if summary.videos_skipped > 0 {
                    println!("   Skipped (video):      {}", summary.videos_skipped);
                }
                if summary.edited_skipped > 0 {
                    println!("   Skipped (-edited):    {}", summary.edited_skipped);
                }
                if summary.no_sidecar > 0 {
                    println!("   No sidecar (EXIF):    {}", summary.no_sidecar);
                }
                if summary.failed > 0 {
                    println!("   Failed:               {}", summary.failed);
                }
            }
            PhotosAction::Match => {
                println!("📷 Matching photos to rides...");
                let summary = dingo_google::match_photos(&pool).await?;

                println!("\n📊 Photo Match Summary:");
                println!("   Rides assigned:       {}", summary.rides_assigned);
                println!("   GPS matched:          {}", summary.gps_matched);
                println!("   Timestamp matched:    {}", summary.timestamp_matched);
                println!("   Still unmatched:      {}", summary.unmatched);
            }
        },
    }

    Ok(())
}

/// Resolve an `--owner` value — an owners.id UUID or an exact
/// (case-insensitive) owners.name — to the id + display name.
async fn resolve_owner(
    pool: &sqlx::PgPool,
    spec: &str,
) -> anyhow::Result<(dingo_core::OwnerId, String)> {
    let found: Option<(dingo_core::OwnerId, String)> =
        match dingo_core::OwnerId::parse(spec) {
            Ok(id) => sqlx::query_as("SELECT id, name FROM owners WHERE id = $1")
                .bind(id)
                .fetch_optional(pool)
                .await?,
            Err(_) => sqlx::query_as("SELECT id, name FROM owners WHERE lower(name) = lower($1)")
                .bind(spec)
                .fetch_optional(pool)
                .await?,
        };
    match found {
        Some(owner) => Ok(owner),
        None => {
            let names: Vec<String> =
                sqlx::query_scalar("SELECT name FROM owners ORDER BY name")
                    .fetch_all(pool)
                    .await?;
            Err(anyhow::anyhow!(
                "no owner matches '{spec}' — known owners: {}",
                names.join(", ")
            ))
        }
    }
}
