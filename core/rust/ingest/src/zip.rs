//! ZIP file handling for Garmin GDPR exports and generic archives
//!
//! Handles nested zip extraction for Garmin data exports and generic zip files.
//!
//! Garmin export structure:
//! export.zip → DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_*_Part*.zip
//!            → {id}_ACTIVITY.zip → {id}_ACTIVITY.fit

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use tempfile::NamedTempFile;
use tracing::{debug, info, warn};
use zip::ZipArchive;

use crate::IngestSummary;
use crate::file_store::FileStore;
use crate::track::RideOrigin;
use dingo_core::{Error, Result};
use sqlx::PgPool;

/// Check if a zip archive is a Garmin GDPR export
pub fn is_garmin_export<R: Read + std::io::Seek>(archive: &mut ZipArchive<R>) -> bool {
    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index_raw(i) {
            let name = file.name();
            // Look for the UploadedFiles Part zips
            if name.contains("DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_")
                && name.ends_with(".zip")
            {
                return true;
            }
            // Also check for Fitness-Uploaded-Files (older format)
            if name.contains("DI_CONNECT/DI-Connect-Fitness-Uploaded-Files/")
                && name.ends_with("_ACTIVITY.zip")
            {
                return true;
            }
        }
    }
    false
}

/// Categorize a FIT file from its name
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FitFileType {
    Activity,
    Wellness,
    Sleep,
    Unknown,
}

/// Process a Garmin GDPR export zip
/// Structure: outer.zip → UploadedFiles_Part*.zip → {id}_ACTIVITY.zip → {id}.fit
pub async fn process_garmin_export(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    origin: RideOrigin,
) -> Result<IngestSummary> {
    process_garmin_export_limited(pool, file_store, path, None, origin).await
}

/// Process a Garmin GDPR export zip with optional limit
pub async fn process_garmin_export_limited(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    limit: Option<usize>,
    origin: RideOrigin,
) -> Result<IngestSummary> {
    let file = File::open(path).map_err(Error::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|e| Error::InvalidInput(e.to_string()))?;

    let mut summary = IngestSummary::default();

    // Find the UploadedFiles Part zips (level 1 nesting)
    let part_zips: Vec<usize> = (0..archive.len())
        .filter(|&i| {
            if let Ok(entry) = archive.by_index_raw(i) {
                let name = entry.name();
                name.contains("DI-Connect-Uploaded-Files/UploadedFiles_") && name.ends_with(".zip")
            } else {
                false
            }
        })
        .collect();

    if part_zips.is_empty() {
        // Try older format: direct activity zips
        return process_garmin_export_direct(pool, file_store, path, origin).await;
    }

    info!(
        parts = part_zips.len(),
        "Found UploadedFiles parts in Garmin export"
    );

    for part_index in part_zips {
        // Extract part zip to temp
        let mut part_entry = archive
            .by_index(part_index)
            .map_err(|e| Error::InvalidInput(e.to_string()))?;

        let part_name = part_entry.name().to_string();
        info!(part = %part_name, "Processing part zip");

        let mut temp_part = NamedTempFile::with_suffix(".zip").map_err(Error::Io)?;
        std::io::copy(&mut part_entry, &mut temp_part).map_err(Error::Io)?;
        temp_part.flush().map_err(Error::Io)?;

        // Open the part zip - it contains FIT files directly
        let part_file = File::open(temp_part.path()).map_err(Error::Io)?;
        let mut part_archive = match ZipArchive::new(part_file) {
            Ok(a) => a,
            Err(e) => {
                warn!(part = %part_name, error = %e, "Failed to open part zip");
                continue;
            }
        };

        // Find FIT files directly in this part (format: username_id.fit)
        let fit_files: Vec<usize> = (0..part_archive.len())
            .filter(|&i| {
                if let Ok(entry) = part_archive.by_index_raw(i) {
                    entry.name().ends_with(".fit")
                } else {
                    false
                }
            })
            .collect();

        let total_in_part = fit_files.len();
        info!(part = %part_name, fits = total_in_part, "Found FIT files in part");

        for (idx, fit_index) in fit_files.into_iter().rev().enumerate() {
            // Progress every 100
            if idx > 0 && idx % 100 == 0 {
                info!(
                    "Processing {}/{} FIT files in {}...",
                    idx, total_in_part, part_name
                );
            }

            let mut fit_entry = match part_archive.by_index(fit_index) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let fit_name = fit_entry.name().to_string();

            // Extract and ingest FIT
            let mut temp_fit = NamedTempFile::with_suffix(".fit").map_err(Error::Io)?;
            std::io::copy(&mut fit_entry, &mut temp_fit).map_err(Error::Io)?;
            temp_fit.flush().map_err(Error::Io)?;

            summary.files_processed += 1;

            match crate::ingest_file(pool, file_store, temp_fit.path(), origin).await {
                Ok(result) => {
                    if result.was_duplicate {
                        summary.files_skipped_duplicate += 1;
                    } else {
                        summary.files_imported += 1;
                        summary.tracks_created += result.track_count;

                        // Check limit
                        if let Some(max) = limit {
                            if summary.files_imported >= max {
                                info!(limit = max, "Reached import limit");
                                return Ok(summary);
                            }
                        }
                    }
                }
                Err(e) => {
                    let err_str = e.to_string();
                    if err_str.contains("No GPS records") {
                        debug!(file = %fit_name, "No GPS data");
                        summary.files_skipped_unsupported += 1;
                    } else {
                        warn!(file = %fit_name, error = %e, "Failed to ingest");
                        summary.files_failed += 1;
                    }
                }
            }
        }
    }

    info!(
        imported = summary.files_imported,
        duplicates = summary.files_skipped_duplicate,
        skipped = summary.files_skipped_unsupported,
        failed = summary.files_failed,
        "Garmin export processing complete"
    );

    Ok(summary)
}

/// Process older Garmin format with direct activity zips
async fn process_garmin_export_direct(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    origin: RideOrigin,
) -> Result<IngestSummary> {
    let file = File::open(path).map_err(Error::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|e| Error::InvalidInput(e.to_string()))?;

    let mut summary = IngestSummary::default();

    let activity_zips: Vec<usize> = (0..archive.len())
        .filter(|&i| {
            if let Ok(entry) = archive.by_index_raw(i) {
                entry.name().ends_with("_ACTIVITY.zip")
            } else {
                false
            }
        })
        .collect();

    let total = activity_zips.len();
    info!(total, "Found activity zips (direct format)");

    for (idx, zip_index) in activity_zips.into_iter().enumerate() {
        if idx > 0 && idx % 50 == 0 {
            info!("Processing {}/{} activities...", idx, total);
        }

        let mut activity_entry = archive
            .by_index(zip_index)
            .map_err(|e| Error::InvalidInput(e.to_string()))?;

        let activity_name = activity_entry.name().to_string();

        let mut temp_activity = NamedTempFile::with_suffix(".zip").map_err(Error::Io)?;
        std::io::copy(&mut activity_entry, &mut temp_activity).map_err(Error::Io)?;
        temp_activity.flush().map_err(Error::Io)?;

        let activity_file = File::open(temp_activity.path()).map_err(Error::Io)?;
        let mut activity_archive = match ZipArchive::new(activity_file) {
            Ok(a) => a,
            Err(e) => {
                warn!(activity = %activity_name, error = %e, "Failed to open");
                summary.files_failed += 1;
                continue;
            }
        };

        let fit_index = (0..activity_archive.len()).find(|&i| {
            if let Ok(entry) = activity_archive.by_index_raw(i) {
                entry.name().ends_with(".fit")
            } else {
                false
            }
        });

        let Some(fit_idx) = fit_index else {
            continue;
        };

        let mut fit_entry = activity_archive
            .by_index(fit_idx)
            .map_err(|e| Error::InvalidInput(e.to_string()))?;

        let fit_name = fit_entry.name().to_string();

        let mut temp_fit = NamedTempFile::with_suffix(".fit").map_err(Error::Io)?;
        std::io::copy(&mut fit_entry, &mut temp_fit).map_err(Error::Io)?;
        temp_fit.flush().map_err(Error::Io)?;

        summary.files_processed += 1;

        match crate::ingest_file(pool, file_store, temp_fit.path(), origin).await {
            Ok(result) => {
                if result.was_duplicate {
                    summary.files_skipped_duplicate += 1;
                } else {
                    summary.files_imported += 1;
                    summary.tracks_created += result.track_count;
                }
            }
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("No GPS records") {
                    debug!(file = %fit_name, "No GPS data");
                    summary.files_skipped_unsupported += 1;
                } else {
                    warn!(file = %fit_name, error = %e, "Failed to ingest");
                    summary.files_failed += 1;
                }
            }
        }
    }

    Ok(summary)
}

/// Process a generic zip file (extract and recurse)
pub async fn process_generic_zip(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    origin: RideOrigin,
) -> Result<IngestSummary> {
    let file = File::open(path).map_err(Error::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|e| Error::InvalidInput(e.to_string()))?;

    let mut summary = IngestSummary::default();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| Error::InvalidInput(e.to_string()))?;

        if entry.is_dir() {
            continue;
        }

        let name = entry.name().to_string();
        let lower = name.to_lowercase();

        // Strava exports store activities gzip-compressed (e.g.
        // "activities/12345.gpx.gz", "12345.fit.gz"). Decompress in-memory,
        // then treat by the inner extension.
        let gzipped = lower.ends_with(".gz");
        let effective = if gzipped {
            lower.trim_end_matches(".gz").to_string()
        } else {
            lower.clone()
        };

        let ext = effective.rsplit('.').next().map(|s| s.to_string());
        let supported = matches!(
            ext.as_deref(),
            Some("gpx") | Some("fit") | Some("kml") | Some("geojson") | Some("tcx")
        );

        if !supported {
            continue;
        }

        let suffix = format!(".{}", ext.unwrap_or_default());
        let mut temp_file = NamedTempFile::with_suffix(&suffix).map_err(Error::Io)?;
        if gzipped {
            let mut decoder = flate2::read::GzDecoder::new(&mut entry);
            if let Err(e) = std::io::copy(&mut decoder, &mut temp_file) {
                warn!(file = %name, error = %e, "Failed to gunzip archive entry");
                summary.files_failed += 1;
                continue;
            }
        } else {
            std::io::copy(&mut entry, &mut temp_file).map_err(Error::Io)?;
        }
        temp_file.flush().map_err(Error::Io)?;

        summary.files_processed += 1;

        match crate::ingest_file(pool, file_store, temp_file.path(), origin).await {
            Ok(result) => {
                if result.was_duplicate {
                    summary.files_skipped_duplicate += 1;
                } else {
                    summary.files_imported += 1;
                    summary.tracks_created += result.track_count;
                }
            }
            Err(e) => {
                if matches!(&e, Error::InvalidInput(msg) if msg.contains("Unsupported") || msg.contains("No GPS"))
                {
                    summary.files_skipped_unsupported += 1;
                } else {
                    warn!(file = %name, error = %e, "Failed to ingest");
                    summary.files_failed += 1;
                }
            }
        }
    }

    Ok(summary)
}

/// Main entry point for zip file ingestion
pub async fn ingest_zip(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    origin: RideOrigin,
) -> Result<IngestSummary> {
    ingest_zip_limited(pool, file_store, path, None, origin).await
}

/// Main entry point for zip file ingestion with optional limit
pub async fn ingest_zip_limited(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    limit: Option<usize>,
    origin: RideOrigin,
) -> Result<IngestSummary> {
    let file = File::open(path).map_err(Error::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|e| Error::InvalidInput(e.to_string()))?;

    if is_garmin_export(&mut archive) {
        info!(path = %path.display(), limit = ?limit, "Detected Garmin GDPR export");
        process_garmin_export_limited(pool, file_store, path, limit, origin).await
    } else {
        info!(path = %path.display(), "Processing generic zip file");
        process_generic_zip(pool, file_store, path, origin).await
    }
}
