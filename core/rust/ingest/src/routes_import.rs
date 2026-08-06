//! Planned-route import — curated route files become planned rides + POIs
//!
//! Unlike recorded-ride ingest, a route file's tracks land as
//! `kind='planned'` rides grouped under a collection label, its top-level
//! waypoints become POIs, and none of the recorded pipeline (enrichment,
//! mode classification, dedupe, library placement) applies.

use sqlx::PgPool;
use std::path::Path;
use tracing::info;

use dingo_core::{Error, FileId, Result};

use crate::file_store::FileStore;
use crate::format::{FileFormat, detect_format};
use crate::gpx::parse_gpx_file;
use crate::palette::assign_colors;
use crate::repository;

/// Result of importing one route file
#[derive(Debug)]
pub struct RoutesImportResult {
    pub file_id: FileId,
    pub collection: String,
    pub routes_created: usize,
    pub pois_created: usize,
    /// Rides + POIs removed by `replace` (0, 0 for a fresh collection)
    pub replaced: (u64, u64),
}

/// Import a GPX route file as a planned-route collection.
///
/// * `collection` — human label grouping the file's routes ("GOAT NSW North").
/// * `replace` — delete the collection's existing planned rides + POIs first.
///   Without it, importing into an existing collection is an error, so a
///   re-download can't silently duplicate a network.
pub async fn import_routes(
    pool: &PgPool,
    file_store: &FileStore,
    path: &Path,
    collection: &str,
    replace: bool,
) -> Result<RoutesImportResult> {
    let collection = collection.trim();
    if collection.is_empty() {
        return Err(Error::InvalidInput("collection label is empty".into()));
    }

    let contents = std::fs::read(path).map_err(Error::Io)?;
    let format = detect_format(&contents);
    if format != FileFormat::Gpx {
        return Err(Error::InvalidInput(format!(
            "planned-route import only supports GPX (got {:?}: {})",
            format,
            path.display()
        )));
    }

    if repository::collection_exists(pool, collection).await? && !replace {
        return Err(Error::InvalidInput(format!(
            "collection \"{collection}\" already exists — pass --replace to re-import it"
        )));
    }

    let parsed = parse_gpx_file(&contents).map_err(|e| Error::InvalidInput(e.to_string()))?;
    if parsed.tracks.is_empty() && parsed.waypoints.is_empty() {
        return Err(Error::InvalidInput("file has no tracks or waypoints".into()));
    }

    // Colors: keep any parsed from extensions, palette-fill the rest
    // (stable by name order, so re-imports reproduce the same colors)
    let names_and_colors: Vec<(String, Option<String>)> = parsed
        .tracks
        .iter()
        .map(|t| (t.name.clone().unwrap_or_default(), t.color.clone()))
        .collect();
    let colors = assign_colors(&names_and_colors);

    // Store the raw file (content-addressed; reuse the row if these exact
    // bytes were imported before — e.g. re-running with --replace)
    let stored = file_store
        .store(path)
        .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?;
    let source_path = std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned();

    let mut tx = pool.begin().await?;

    let file_id = match repository::file_exists_by_hash(pool, &stored.hash).await? {
        Some(existing) => existing,
        None => {
            repository::insert_file(
                &mut *tx,
                stored.id,
                &stored.hash,
                format,
                &stored.original_name,
                stored.size as i64,
                stored.stored_path.to_str().unwrap_or(""),
                Some(&source_path),
            )
            .await?
        }
    };

    let replaced = if replace {
        let rides = repository::delete_collection_rides(&mut *tx, collection).await?;
        let pois = repository::delete_collection_pois(&mut *tx, collection).await?;
        (rides, pois)
    } else {
        (0, 0)
    };

    let mut routes_created = 0;
    for (track, color) in parsed.tracks.iter().zip(colors.iter()) {
        if track.points.len() < 2 {
            continue;
        }
        repository::insert_planned_ride(&mut *tx, file_id, track, collection, color).await?;
        routes_created += 1;
    }

    let mut pois_created = 0;
    for waypoint in &parsed.waypoints {
        repository::insert_poi(&mut *tx, waypoint, collection, file_id).await?;
        pois_created += 1;
    }

    tx.commit().await?;

    info!(
        collection,
        routes = routes_created,
        pois = pois_created,
        replaced_rides = replaced.0,
        replaced_pois = replaced.1,
        "Imported planned-route collection"
    );

    Ok(RoutesImportResult {
        file_id,
        collection: collection.to_string(),
        routes_created,
        pois_created,
        replaced,
    })
}
