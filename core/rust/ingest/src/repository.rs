//! Database operations for file and ride ingestion

use dingo_core::{Error, FileId, Result, RideId};
use sqlx::{PgExecutor, PgPool};

use crate::format::FileFormat;
use crate::track::{RideOrigin, Track, TrackType};

/// Insert a new file record into the database
///
/// Accepts any executor (pool or transaction) so callers can insert the file
/// and its rides atomically — see `service::ingest_file`.
pub async fn insert_file(
    executor: impl PgExecutor<'_>,
    id: FileId,
    hash: &str,
    format: FileFormat,
    original_name: &str,
    size_bytes: i64,
    stored_path: &str,
    source_path: Option<&str>,
) -> Result<FileId> {
    let format_str = format.extension();

    sqlx::query!(
        r#"
        INSERT INTO files (id, hash, format, original_name, size_bytes, stored_path, source_path)
        VALUES ($1, $2, $3::file_format, $4, $5, $6, $7)
        ON CONFLICT (hash) DO NOTHING
        RETURNING id
        "#,
        id.0,
        hash,
        format_str as _,
        original_name,
        size_bytes,
        stored_path,
        source_path
    )
    .fetch_optional(executor)
    .await?
    .map(|r| FileId::from_uuid(r.id))
    .ok_or_else(|| Error::Other("File already exists (hash conflict)".to_string()))
}

/// Check if a file with this hash already exists
pub async fn file_exists_by_hash(pool: &PgPool, hash: &str) -> Result<Option<FileId>> {
    let result = sqlx::query!(r#"SELECT id FROM files WHERE hash = $1"#, hash)
        .fetch_optional(pool)
        .await?;

    Ok(result.map(|r| FileId::from_uuid(r.id)))
}

/// Insert a new ride record into the database.
///
/// `filename` is the source file's own name, stored as its own name variant —
/// a GPX called `2026-06-01_flinders_day2.gpx` often carries a quite
/// different `<trk><name>`, and both are worth keeping.
pub async fn insert_ride(
    executor: impl PgExecutor<'_>,
    file_id: FileId,
    track: &Track,
    origin: RideOrigin,
    filename: &str,
) -> Result<RideId> {
    let ride_id = RideId::new();

    // Which name the ride displays until the user says otherwise. A file that
    // named its track something real keeps that name; a FIT sport string or
    // an "Active Log: ..." default is not worth showing, so the ride waits for
    // the namer's generated name instead. Without this the ride would display
    // "cycling" for ever, because the namer no longer overwrites `name`.
    let name_source = if dingo_core::is_junk_name(track.name.as_deref()) {
        "generated"
    } else {
        "original"
    };

    // Convert points to GeoJSON for PostGIS
    let geojson = track_to_geojson(track);
    let time_series = serde_json::to_value(&track.points)?;

    let track_type_str = match track.track_type {
        TrackType::Ride => "ride",
        TrackType::Route => "route",
    };

    let has_heart_rate = track.points.iter().any(|p| p.heart_rate.is_some());
    let has_cadence = track.points.iter().any(|p| p.cadence.is_some());
    let has_power = track.points.iter().any(|p| p.power.is_some());

    sqlx::query!(
        r#"
        INSERT INTO rides (
            id, file_id, name, track_type, source_format,
            started_at, ended_at,
            raw_geometry, raw_time_series,
            has_heart_rate, has_cadence, has_power,
            fit_sport, fit_sub_sport, device_manufacturer, device_product,
            origin,
            original_name, filename, name_source
        )
        VALUES (
            $1, $2,
            resolve_ride_name($18, $3, $19, NULL, NULL),
            $4::track_type, $5,
            $6, $7,
            ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($8), 4326)), $9,
            $10, $11, $12,
            $13, $14, $15, $16,
            $17::ride_origin,
            $3, $19, $18::ride_name_source
        )
        "#,
        ride_id.0,
        file_id.0,
        track.name,
        track_type_str as _,
        track.source_format,
        track.started_at,
        track.ended_at,
        geojson,
        time_series,
        has_heart_rate,
        has_cadence,
        has_power,
        track.fit_sport,
        track.fit_sub_sport,
        track.device_manufacturer,
        track.device_product,
        origin.as_str() as _,
        name_source,
        filename
    )
    .execute(executor)
    .await?;

    Ok(ride_id)
}

/// Insert a planned ride (curated route without timings). Geometry goes in
/// as both raw and cleaned — route files carry no GPS jitter to clean, and
/// pre-setting cleaned_at keeps `dingo clean` (and mode reclassification,
/// which keys off cleaned_time_series + mode_source) away from it. The
/// zoom-level simplifications are computed here so the heatmap endpoint can
/// serve planned routes immediately.
#[allow(clippy::too_many_arguments)]
pub async fn insert_planned_ride(
    executor: impl PgExecutor<'_>,
    file_id: FileId,
    track: &Track,
    collection: &str,
    color: &str,
) -> Result<RideId> {
    let ride_id = RideId::new();
    let geojson = track_to_geojson(track);
    let time_series = serde_json::to_value(&track.points)?;

    sqlx::query!(
        r#"
        INSERT INTO rides (
            id, file_id, name, track_type, source_format,
            raw_geometry, raw_time_series,
            cleaned_geometry, cleaned_time_series, cleaned_at,
            geometry_z10, geometry_z14,
            origin, kind, collection, color, description
        )
        SELECT
            $1, $2, $3, 'route'::track_type, $4,
            g.geom, $6,
            g.geom, $6, NOW(),
            ST_SimplifyPreserveTopology(g.geom, 0.001),
            ST_SimplifyPreserveTopology(g.geom, 0.0001),
            'other'::ride_origin, 'planned'::ride_kind, $7, $8, $9
        FROM (
            SELECT ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)) AS geom
        ) g
        "#,
        ride_id.0,
        file_id.0,
        track.name,
        track.source_format,
        geojson,
        time_series,
        collection,
        color,
        track.description
    )
    .execute(executor)
    .await?;

    Ok(ride_id)
}

/// Insert a POI parsed from a route file's top-level waypoints
pub async fn insert_poi(
    executor: impl PgExecutor<'_>,
    waypoint: &crate::gpx::GpxWaypoint,
    collection: &str,
    file_id: FileId,
) -> Result<()> {
    let category = dingo_core::poi::PoiCategory::from_garmin_sym(waypoint.sym.as_deref());
    let name = waypoint.name.as_deref().unwrap_or("Unnamed");

    sqlx::query!(
        r#"
        INSERT INTO pois (position, elevation, name, description, category, raw_sym, collection, file_id)
        VALUES (
            ST_SetSRID(ST_MakePoint($1, $2), 4326),
            $3, $4, $5, $6::poi_category, $7, $8, $9
        )
        "#,
        waypoint.lon,
        waypoint.lat,
        waypoint.elevation.map(|e| e as f32),
        name,
        waypoint.description,
        category.as_str() as _,
        waypoint.sym,
        collection,
        file_id.0
    )
    .execute(executor)
    .await?;

    Ok(())
}

/// Does a planned-route collection with this label already exist?
pub async fn collection_exists(pool: &PgPool, collection: &str) -> Result<bool> {
    let row = sqlx::query!(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM rides WHERE kind = 'planned' AND collection = $1
            UNION
            SELECT 1 FROM pois WHERE collection = $1
        ) AS "exists!"
        "#,
        collection
    )
    .fetch_one(pool)
    .await?;
    Ok(row.exists)
}

/// Delete a collection's POIs (the re-import path). Files rows and stored
/// bytes are left alone — the store is content-addressed.
pub async fn delete_collection_pois(
    executor: impl PgExecutor<'_>,
    collection: &str,
) -> Result<u64> {
    let pois = sqlx::query!(r#"DELETE FROM pois WHERE collection = $1"#, collection)
        .execute(executor)
        .await?
        .rows_affected();
    Ok(pois)
}

/// Delete the planned rides of a collection (separate function so the two
/// deletes can share one transaction with the caller's inserts)
pub async fn delete_collection_rides(
    executor: impl PgExecutor<'_>,
    collection: &str,
) -> Result<u64> {
    let rides = sqlx::query!(
        r#"DELETE FROM rides WHERE kind = 'planned' AND collection = $1"#,
        collection
    )
    .execute(executor)
    .await?
    .rows_affected();
    Ok(rides)
}

/// Convert track points to GeoJSON LineString (2D - elevation stored in time_series)
fn track_to_geojson(track: &Track) -> String {
    let coordinates: Vec<String> = track
        .points
        .iter()
        .map(|p| format!("[{}, {}]", p.lon, p.lat))
        .collect();

    format!(
        r#"{{"type": "LineString", "coordinates": [{}]}}"#,
        coordinates.join(", ")
    )
}
