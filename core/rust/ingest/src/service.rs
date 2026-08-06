//! Ingest service - orchestrates file storage, parsing, and database insertion

use sqlx::PgPool;
use std::path::Path;
use tracing::{debug, info, warn};

use dingo_core::{Error, FileId, Result, RideId};

use crate::file_store::FileStore;
use crate::fit::parse_fit;
use crate::format::{FileFormat, detect_format};
use crate::gpx::parse_gpx;
use crate::repository;
use crate::track::RideOrigin;

/// Result of ingesting a single file
#[derive(Debug)]
pub struct IngestResult {
    pub file_id: FileId,
    pub ride_ids: Vec<RideId>,
    pub track_count: usize,
    pub was_duplicate: bool,
    pub format: FileFormat,
}

/// Summary of ingesting multiple files
#[derive(Debug, Default)]
pub struct IngestSummary {
    pub files_processed: usize,
    pub files_imported: usize,
    pub files_skipped_duplicate: usize,
    pub files_skipped_unsupported: usize,
    pub files_failed: usize,
    pub tracks_created: usize,
    /// Source paths whose bytes are safely in the hash store (imported or
    /// already-present duplicates) — the set a caller may consume. Empty for
    /// zip ingests, whose members never exist as loose files on disk.
    pub sources_ok: Vec<std::path::PathBuf>,
}

/// Ingest a single file
pub async fn ingest_file(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    origin: RideOrigin,
) -> Result<IngestResult> {
    // Read file contents
    let contents = std::fs::read(path).map_err(Error::Io)?;

    // Detect format
    let format = detect_format(&contents);
    if format == FileFormat::Unknown {
        return Err(Error::InvalidInput(format!(
            "Unsupported file format: {}",
            path.display()
        )));
    }

    // Store file (content-addressed)
    let stored = file_store.store(path).map_err(|e| {
        Error::Io(std::io::Error::other(
            e.to_string(),
        ))
    })?;

    // Check if already in database
    if let Some(existing_id) = repository::file_exists_by_hash(pool, &stored.hash).await? {
        debug!(hash = %stored.hash, "File already in database, skipping");
        return Ok(IngestResult {
            file_id: existing_id,
            ride_ids: vec![],
            track_count: 0,
            was_duplicate: true,
            format,
        });
    }

    // Parse tracks from file
    let tracks = match format {
        FileFormat::Gpx => parse_gpx(&contents).map_err(|e| Error::InvalidInput(e.to_string()))?,
        FileFormat::Fit => parse_fit(&contents).map_err(|e| Error::InvalidInput(e.to_string()))?,
        _ => {
            return Err(Error::InvalidInput(format!(
                "Parser not yet implemented for format: {format:?}"
            )));
        }
    };

    let track_count = tracks.len();

    // Insert the file row and every track's ride row in one transaction. If any
    // insert fails, the whole thing rolls back — including the files row — so a
    // retry re-parses the file and re-inserts all tracks. Committing the files
    // row before the rides (the previous behaviour) meant a mid-loop failure
    // left a hash the next run treated as a duplicate, silently losing tracks.
    let mut tx = pool.begin().await?;

    let file_id = repository::insert_file(
        &mut *tx,
        stored.id,
        &stored.hash,
        format,
        &stored.original_name,
        stored.size as i64,
        stored.stored_path.to_str().unwrap_or(""),
        path.to_str(),
    )
    .await?;

    let mut ride_ids = Vec::with_capacity(tracks.len());
    for track in &tracks {
        let ride_id = repository::insert_ride(&mut *tx, file_id, track, origin).await?;
        ride_ids.push(ride_id);
        info!(
            ride_id = %ride_id,
            name = ?track.name,
            points = track.points.len(),
            "Created ride"
        );
    }

    tx.commit().await?;

    info!(
        file_id = %file_id,
        format = ?format,
        tracks = track_count,
        "Ingested file"
    );

    Ok(IngestResult {
        file_id,
        ride_ids,
        track_count,
        was_duplicate: false,
        format,
    })
}

/// Ingest all supported files from a directory
pub async fn ingest_directory(
    pool: &PgPool,
    file_store: &FileStore,
    dir_path: &Path,
    origin: RideOrigin,
    limit: Option<usize>,
) -> Result<IngestSummary> {
    let mut summary = IngestSummary::default();

    let entries = std::fs::read_dir(dir_path).map_err(Error::Io)?;

    for entry in entries {
        // Honour --limit: stop once we've imported/skipped that many files
        // (mirrors the zip and Takeout import limit semantics).
        if let Some(n) = limit {
            if summary.files_imported + summary.files_skipped_duplicate >= n {
                break;
            }
        }

        let entry = entry.map_err(Error::Io)?;
        let path = entry.path();

        // Skip directories
        if path.is_dir() {
            continue;
        }

        // Check extension
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());

        let supported = matches!(
            ext.as_deref(),
            Some("gpx") | Some("fit") | Some("kml") | Some("geojson") | Some("tcx")
        );

        if !supported {
            continue;
        }

        summary.files_processed += 1;

        match ingest_file(pool, file_store, &path, origin).await {
            Ok(result) => {
                if result.was_duplicate {
                    summary.files_skipped_duplicate += 1;
                } else {
                    summary.files_imported += 1;
                    summary.tracks_created += result.track_count;
                }
                summary.sources_ok.push(path.clone());
            }
            Err(e) => {
                if matches!(&e, Error::InvalidInput(msg) if msg.contains("Unsupported")) {
                    summary.files_skipped_unsupported += 1;
                } else {
                    warn!(path = %path.display(), error = %e, "Failed to ingest file");
                    summary.files_failed += 1;
                }
            }
        }
    }

    Ok(summary)
}
