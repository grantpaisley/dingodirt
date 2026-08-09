//! ZIP file handling for Garmin GDPR exports and generic archives
//!
//! Handles nested zip extraction for Garmin data exports and generic zip files.
//!
//! Garmin export structure:
//! export.zip → DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_*_Part*.zip
//!            → {id}_ACTIVITY.zip → {id}_ACTIVITY.fit

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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

/// Track formats `ingest_file` can parse out of an archive.
const TRACK_EXTS: [&str; 5] = ["gpx", "fit", "kml", "geojson", "tcx"];

/// How deep to follow nested archives. A Garmin GDPR export nests two deep
/// (export.zip → UploadedFiles_*.zip → *.fit, or → *_ACTIVITY.zip → *.fit);
/// the rest of the budget is slack, and the cap stops a zip bomb.
const MAX_NESTING: usize = 4;

/// Unpack every track file in `zip_path` into `out_dir` and return the
/// extracted paths. Nested archives are followed, and Strava's gzipped
/// entries (`activities/123.gpx.gz`) are decompressed on the way out.
///
/// Each file lands in its own numbered subdirectory under its real basename,
/// so `ingest_file` records the name the archive gave it and same-named
/// entries from different folders don't collide.
///
/// Synchronous on purpose. The zip reader is `!Send`, so `ingest_zip` — which
/// holds it across `.await` — can't run in an axum handler. Extracting first
/// keeps the reader off the async path: callers on a runtime should
/// `spawn_blocking` this, then feed the returned paths to `ingest_file`.
pub fn extract_tracks(zip_path: &Path, out_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut seq = 0usize;
    extract_tracks_into(zip_path, out_dir, 0, &mut seq, &mut out)?;
    Ok(out)
}

fn extract_tracks_into(
    zip_path: &Path,
    out_dir: &Path,
    depth: usize,
    seq: &mut usize,
    out: &mut Vec<PathBuf>,
) -> Result<()> {
    let file = File::open(zip_path).map_err(Error::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|e| Error::InvalidInput(e.to_string()))?;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                warn!(archive = %zip_path.display(), error = %e, "Skipping unreadable zip entry");
                continue;
            }
        };
        if entry.is_dir() {
            continue;
        }

        let name = entry.name().to_string();
        let lower = name.to_ascii_lowercase();
        let gzipped = lower.ends_with(".gz");
        let effective = lower.strip_suffix(".gz").unwrap_or(&lower);
        let ext = effective.rsplit('.').next().unwrap_or("");

        if ext == "zip" {
            if depth >= MAX_NESTING {
                warn!(entry = %name, depth, "Nested zip too deep — skipped");
                continue;
            }
            let mut nested = NamedTempFile::with_suffix(".zip").map_err(Error::Io)?;
            copy_entry(&mut entry, &mut nested, gzipped, &name)?;
            extract_tracks_into(nested.path(), out_dir, depth + 1, seq, out)?;
            continue;
        }
        if !TRACK_EXTS.contains(&ext) {
            continue;
        }

        // Never join the entry name onto out_dir — archive paths can carry
        // "../". Take the basename only, and give each one its own subdir.
        let base = Path::new(effective)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("track");
        let dir = out_dir.join(seq.to_string());
        std::fs::create_dir_all(&dir).map_err(Error::Io)?;
        let path = dir.join(base);
        *seq += 1;

        let mut file = File::create(&path).map_err(Error::Io)?;
        copy_entry(&mut entry, &mut file, gzipped, &name)?;
        file.flush().map_err(Error::Io)?;
        out.push(path);
    }

    Ok(())
}

/// Copy one archive entry out, gunzipping it when the name says so.
fn copy_entry<W: Write>(
    entry: &mut zip::read::ZipFile<'_>,
    sink: &mut W,
    gzipped: bool,
    name: &str,
) -> Result<()> {
    let copied = if gzipped {
        std::io::copy(&mut flate2::read::GzDecoder::new(entry), sink)
    } else {
        std::io::copy(entry, sink)
    };
    copied
        .map(|_| ())
        .map_err(|e| Error::InvalidInput(format!("{name}: {e}")))
}

#[cfg(test)]
mod extract_tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::{SimpleFileOptions, ZipWriter};

    /// A zip built in memory from (name, bytes) pairs, stored uncompressed.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(bytes).unwrap();
        enc.finish().unwrap()
    }

    fn names(paths: &[PathBuf]) -> Vec<String> {
        let mut n: Vec<String> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        n.sort();
        n
    }

    #[test]
    fn extracts_nested_gzipped_and_ignores_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let inner = build_zip(&[("ride2.fit", b"fit-bytes")]);
        let outer = build_zip(&[
            ("tracks/ride1.gpx", b"<gpx/>"),
            ("nested/inner.zip", &inner),
            ("activities/ride3.gpx.gz", &gzip(b"<gpx>three</gpx>")),
            ("README.txt", b"not a track"),
        ]);
        let zip_path = dir.path().join("outer.zip");
        std::fs::write(&zip_path, &outer).unwrap();

        let out = dir.path().join("out");
        let got = extract_tracks(&zip_path, &out).unwrap();

        assert_eq!(names(&got), ["ride1.gpx", "ride2.fit", "ride3.gpx"]);
        // The .gz is decompressed on the way out, so ingest_file sees GPX.
        let three = got.iter().find(|p| p.ends_with("ride3.gpx")).unwrap();
        assert_eq!(std::fs::read(three).unwrap(), b"<gpx>three</gpx>");
    }

    #[test]
    fn same_named_entries_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("dup.zip");
        std::fs::write(
            &zip_path,
            build_zip(&[("jan/ride.gpx", b"<gpx>a</gpx>"), ("feb/ride.gpx", b"<gpx>b</gpx>")]),
        )
        .unwrap();

        let out = dir.path().join("out");
        let got = extract_tracks(&zip_path, &out).unwrap();

        assert_eq!(got.len(), 2);
        assert_eq!(names(&got), ["ride.gpx", "ride.gpx"]);
        assert_ne!(std::fs::read(&got[0]).unwrap(), std::fs::read(&got[1]).unwrap());
    }

    #[test]
    fn traversal_entries_stay_inside_the_output_dir() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("evil.zip");
        std::fs::write(&zip_path, build_zip(&[("../../escaped.gpx", b"<gpx/>")])).unwrap();

        let out = dir.path().join("out");
        let got = extract_tracks(&zip_path, &out).unwrap();

        assert_eq!(got.len(), 1);
        assert!(got[0].starts_with(&out), "escaped to {}", got[0].display());
        assert!(!dir.path().parent().unwrap().join("escaped.gpx").exists());
    }
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
