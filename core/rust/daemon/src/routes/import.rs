//! Web import: multipart GPX/FIT/ZIP upload → the normal ingest path, with a
//! source tag ('wikiloc', 'dsra', a mate's name, …), origin (self/other), and
//! owner assignment. New rides are cleaned, named/located, and placed into
//! the browsable library tree (DINGO_LIBRARY_PATH) before the response
//! returns — the per-file `stored` field reports where each track landed.
//! This is also what removes the local-filesystem Inbox dependency once the
//! daemon is hosted (dingodirt.com).

use axum::extract::{DefaultBodyLimit, Extension, Multipart};
use axum::{Json, Router, routing::post};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

type ApiError = (axum::http::StatusCode, String);

fn internal(e: impl std::fmt::Display) -> ApiError {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

pub fn routes() -> Router {
    Router::new()
        .route("/", post(import_files))
        .route("/gmaps", post(import_gmaps))
        // GPX files run to tens of MB; Strava/Garmin zips to hundreds
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
}

#[derive(Debug, Serialize)]
struct ImportedFile {
    name: String,
    /// Rides created (0 for duplicates)
    rides: usize,
    duplicate: bool,
    error: Option<String>,
    /// Where the ride(s) landed in the library tree, relative to
    /// DINGO_LIBRARY_PATH (None when ingest failed or placement is pending)
    stored: Option<String>,
}

#[derive(Debug, Serialize)]
struct ImportResponse {
    files: Vec<ImportedFile>,
    rides_created: usize,
    note: String,
}

#[axum::debug_handler]
async fn import_files(
    Extension(pool): Extension<PgPool>,
    mut multipart: Multipart,
) -> Result<Json<ImportResponse>, ApiError> {
    let config = dingo_core::Config::load().map_err(internal)?;
    let store = dingo_ingest::FileStore::new(&config.file_store_path).map_err(internal)?;

    let scratch = std::env::temp_dir().join(format!("dingo-import-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).map_err(internal)?;

    // Field order isn't guaranteed, so buffer files first and read the tag
    // fields as they appear.
    let mut source: Option<String> = None;
    let mut origin = dingo_ingest::RideOrigin::Own;
    let mut owner_id: Option<Uuid> = None;
    let mut saved: Vec<(String, std::path::PathBuf)> = Vec::new();

    while let Some(field) = multipart.next_field().await.map_err(internal)? {
        match field.name().unwrap_or("") {
            "source" => {
                let v = field.text().await.map_err(internal)?;
                let v = v.trim().to_string();
                if !v.is_empty() {
                    source = Some(v);
                }
            }
            "origin" => {
                if field.text().await.map_err(internal)?.trim() == "other" {
                    origin = dingo_ingest::RideOrigin::Other;
                }
            }
            "owner_id" => {
                let v = field.text().await.map_err(internal)?;
                if let Ok(uuid) = Uuid::parse_str(v.trim()) {
                    owner_id = Some(uuid);
                }
            }
            "files" => {
                let name = field
                    .file_name()
                    .map(sanitize_upload_name)
                    .unwrap_or_else(|| format!("upload-{}", saved.len()));
                let bytes = field.bytes().await.map_err(internal)?;
                // Per-file subdir so the DB's original_name is the real
                // filename, not an index-prefixed scratch name.
                let dir = scratch.join(saved.len().to_string());
                std::fs::create_dir_all(&dir).map_err(internal)?;
                let path = dir.join(&name);
                std::fs::write(&path, &bytes).map_err(internal)?;
                saved.push((name, path));
            }
            _ => {}
        }
    }
    if saved.is_empty() {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err((axum::http::StatusCode::BAD_REQUEST, "no files uploaded".into()));
    }

    let mut files = Vec::new();
    // Ride ids per uploaded file, so placement paths can be reported per file.
    let mut file_rides: Vec<Vec<Uuid>> = Vec::new();
    let mut rides_created = 0usize;
    let mut all_ids: Vec<Uuid> = Vec::new();
    for (idx, (name, path)) in saved.iter().enumerate() {
        // A zip is unpacked first, then its members go through the same
        // per-file path. ingest_zip itself can't be called here — its future
        // is !Send (the zip reader lives across awaits) — so extraction runs
        // synchronously on a blocking thread and only plain paths come back.
        let is_zip = name.to_ascii_lowercase().ends_with(".zip");
        let members: Vec<std::path::PathBuf> = if is_zip {
            let zip_path = path.clone();
            let out_dir = scratch.join(format!("unzipped-{idx}"));
            let extracted =
                tokio::task::spawn_blocking(move || dingo_ingest::extract_tracks(&zip_path, &out_dir))
                    .await
                    .map_err(internal)?;
            match extracted {
                Ok(paths) if paths.is_empty() => {
                    files.push(ImportedFile {
                        name: name.clone(),
                        rides: 0,
                        duplicate: false,
                        error: Some("no GPX/FIT/TCX/KML/GeoJSON tracks in the archive".into()),
                        stored: None,
                    });
                    file_rides.push(Vec::new());
                    continue;
                }
                Ok(paths) => paths,
                Err(e) => {
                    files.push(ImportedFile {
                        name: name.clone(),
                        rides: 0,
                        duplicate: false,
                        error: Some(e.to_string()),
                        stored: None,
                    });
                    file_rides.push(Vec::new());
                    continue;
                }
            }
        } else {
            vec![path.clone()]
        };

        // One result row per UPLOADED file: an archive's members are tallied
        // into the row for the zip the user actually picked.
        let mut ids: Vec<Uuid> = Vec::new();
        let mut duplicates = 0usize;
        let mut member_errors: Vec<String> = Vec::new();
        for member in &members {
            match dingo_ingest::ingest_file(&pool, &store, member, origin.clone()).await {
                Ok(res) => {
                    if res.was_duplicate {
                        duplicates += 1;
                    }
                    ids.extend(res.ride_ids.iter().map(|r| r.0));
                }
                Err(e) => member_errors.push(e.to_string()),
            }
        }

        if !ids.is_empty() {
            if let Some(tag) = &source {
                sqlx::query("UPDATE rides SET source = $1 WHERE id = ANY($2)")
                    .bind(tag)
                    .bind(&ids)
                    .execute(&pool)
                    .await
                    .map_err(internal)?;
            }
            if let Some(owner) = owner_id {
                sqlx::query("UPDATE rides SET owner_id = $1 WHERE id = ANY($2)")
                    .bind(owner)
                    .bind(&ids)
                    .execute(&pool)
                    .await
                    .map_err(internal)?;
            }
        }

        // A single file reports its own error verbatim; an archive reports a
        // tally, since one bad entry among hundreds isn't the headline.
        let error = match (is_zip, member_errors.len()) {
            (_, 0) => None,
            (false, _) => Some(member_errors.remove(0)),
            (true, failed) => Some(format!(
                "{failed} of {} files in the archive failed — first: {}",
                members.len(),
                member_errors[0],
            )),
        };

        all_ids.extend(ids.iter().copied());
        rides_created += ids.len();
        files.push(ImportedFile {
            name: name.clone(),
            rides: ids.len(),
            duplicate: duplicates == members.len(),
            error,
            stored: None,
        });
        file_rides.push(ids);
    }
    let _ = std::fs::remove_dir_all(&scratch);

    let placed = postprocess_new_rides(&pool, &config, all_ids).await;
    for (i, ids) in file_rides.iter().enumerate() {
        let paths: Vec<&str> = ids
            .iter()
            .filter_map(|id| placed.get(id).map(String::as_str))
            .collect();
        if !paths.is_empty() {
            files[i].stored = Some(paths.join("; "));
        }
    }

    Ok(Json(ImportResponse {
        files,
        rides_created,
        note: "imported rides are cleaned, located and filed into the library tree automatically".into(),
    }))
}

/// The shared post-ingest pipeline: clean, name, turn cues, library
/// placement (returns ride id -> library path), plus the background Strava
/// heat harvest. Every step is best-effort — rides are ingested either way,
/// and the next organize run repairs anything missed.
async fn postprocess_new_rides(
    pool: &PgPool,
    config: &dingo_core::Config,
    ride_ids: Vec<Uuid>,
) -> std::collections::HashMap<Uuid, String> {
    let mut placed = std::collections::HashMap::new();
    if ride_ids.is_empty() {
        return placed;
    }
    if let Err(e) = dingo_geo::clean_all_rides(pool, &dingo_geo::CleaningConfig::default()).await {
        tracing::warn!(error = %e, "post-import cleaning failed");
    }
    if let Err(e) = dingo_enrich::name_unlocated_rides(pool).await {
        tracing::warn!(error = %e, "post-import naming failed (gazetteer empty?)");
    }
    // Turn cues (shared junction marks) — skips with a warning until
    // `dingo gazetteer load-roads` has run.
    if let Err(e) = dingo_geo::turns::enrich_rides_turns(pool, &ride_ids).await {
        tracing::warn!(error = %e, "post-import turn-cue enrichment failed");
    }
    // The placement engine recomputes the whole layout but only writes files
    // that don't exist yet, so steady-state cost is one query + stat calls.
    match dingo_export::place_rides(pool, &config.library_path, &ride_ids).await {
        Ok(p) => placed = p,
        Err(e) => tracing::warn!(error = %e, "post-import library placement failed"),
    }
    // Strava heat corridor in the background so the response returns
    // immediately; runs after cleaning so cleaned_geometry (the corridor
    // source) exists. Auto-fetches if the daemon has valid Strava cookies,
    // otherwise just queues the tiles.
    let pool = pool.clone();
    tokio::spawn(async move {
        super::heat::auto_harvest_import(pool, ride_ids).await;
    });
    placed
}

/// JSON body for the Google Maps URL import.
#[derive(Debug, serde::Deserialize)]
struct GmapsRequest {
    url: String,
    #[serde(default)]
    source: Option<String>,
    /// "self" (default) or "other"
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    owner_id: Option<Uuid>,
}

/// Hosts a directions link may live on — the daemon fetches the URL to
/// resolve share links, so anything else is rejected outright.
fn is_gmaps_host(url: &str) -> bool {
    let Some(host) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .and_then(|r| r.split('/').next())
    else {
        return false;
    };
    let host = host.split('@').next_back().unwrap_or(host); // no userinfo tricks
    let host = host.split(':').next().unwrap_or(host);
    host == "maps.app.goo.gl"
        || host == "goo.gl"
        || host == "google.com"
        || host == "www.google.com"
        || host == "maps.google.com"
        || host.ends_with(".google.com")
}

/// Paste a Google Maps directions link -> routed GPX plan in the library.
/// Resolves the share link, extracts the waypoints, asks the Routes API for
/// the road geometry, synthesizes a timestamp-free GPX and runs it through
/// the exact same pipeline as a file upload.
#[axum::debug_handler]
async fn import_gmaps(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<GmapsRequest>,
) -> Result<Json<ImportResponse>, ApiError> {
    let config = dingo_core::Config::load().map_err(internal)?;
    let Some(api_key) = config.google_maps_api_key.clone() else {
        return Err((
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "GOOGLE_MAPS_API_KEY is not set — create a Google Cloud API key with the \
             Routes API enabled and add GOOGLE_MAPS_API_KEY to the daemon's environment"
                .into(),
        ));
    };

    let url = body.url.trim();
    if !is_gmaps_host(url) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "expected a Google Maps link (maps.app.goo.gl or google.com/maps/dir/…)".into(),
        ));
    }

    let bad = |e: dingo_core::Error| (axum::http::StatusCode::BAD_REQUEST, e.to_string());
    let full = dingo_google::resolve_url(url).await.map_err(bad)?;
    let req = dingo_google::parse_dir_url(&full).map_err(bad)?;
    let points = dingo_google::compute_route(&req, &api_key).await.map_err(bad)?;
    if points.len() < 2 {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "Routes API returned an empty route".into(),
        ));
    }
    let gpx = dingo_google::build_route_gpx(&req, url, &points);

    // Same scratch-file convention as the upload path, so original_name is
    // the route title.
    let store = dingo_ingest::FileStore::new(&config.file_store_path).map_err(internal)?;
    let scratch = std::env::temp_dir().join(format!("dingo-import-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).map_err(internal)?;
    let file_name = format!(
        "{}.gpx",
        dingo_export::sanitize_filename(gpx_title(&gpx).as_deref().unwrap_or("Google Maps route"))
    );
    let path = scratch.join(&file_name);
    std::fs::write(&path, gpx.as_bytes()).map_err(internal)?;

    let origin = if body.origin.as_deref() == Some("other") {
        dingo_ingest::RideOrigin::Other
    } else {
        dingo_ingest::RideOrigin::Own
    };
    let result = dingo_ingest::ingest_file(&pool, &store, &path, origin).await;
    let _ = std::fs::remove_dir_all(&scratch);
    let res = result.map_err(|e| internal(format!("routed GPX failed to ingest: {e}")))?;

    let ids: Vec<Uuid> = res.ride_ids.iter().map(|r| r.0).collect();
    if !ids.is_empty() {
        let source = body.source.as_deref().unwrap_or("google-maps");
        sqlx::query("UPDATE rides SET source = $1 WHERE id = ANY($2)")
            .bind(source)
            .bind(&ids)
            .execute(&pool)
            .await
            .map_err(internal)?;
        if let Some(owner) = body.owner_id {
            sqlx::query("UPDATE rides SET owner_id = $1 WHERE id = ANY($2)")
                .bind(owner)
                .bind(&ids)
                .execute(&pool)
                .await
                .map_err(internal)?;
        }
    }

    let placed = postprocess_new_rides(&pool, &config, ids.clone()).await;
    let stored = {
        let paths: Vec<&str> = ids
            .iter()
            .filter_map(|id| placed.get(id).map(String::as_str))
            .collect();
        (!paths.is_empty()).then(|| paths.join("; "))
    };

    Ok(Json(ImportResponse {
        files: vec![ImportedFile {
            name: file_name,
            rides: res.ride_ids.len(),
            duplicate: res.was_duplicate,
            error: None,
            stored,
        }],
        rides_created: res.ride_ids.len(),
        note: "route imported as a plan; cleaned, located and filed into the library tree".into(),
    }))
}

/// The `<name>` of the first `<metadata>` block (the synthesized route title).
fn gpx_title(gpx: &str) -> Option<String> {
    let start = gpx.find("<name>")? + "<name>".len();
    let end = gpx[start..].find("</name>")? + start;
    Some(gpx[start..end].replace("&amp;", "&"))
}

/// Keep just a safe basename from whatever the browser sends.
fn sanitize_upload_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    base.chars()
        .map(|c| if c == '\0' { '-' } else { c })
        .take(120)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::sanitize_upload_name;

    #[test]
    fn upload_name_strips_paths_and_traversal() {
        assert_eq!(sanitize_upload_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_upload_name("/abs/ride.gpx"), "ride.gpx");
        assert_eq!(sanitize_upload_name("C:\\Users\\x\\ride.gpx"), "ride.gpx");
        assert_eq!(sanitize_upload_name("plain.gpx"), "plain.gpx");
        // NUL becomes '-', not a path break
        assert!(!sanitize_upload_name("a\0b.gpx").contains('\0'));
    }
}
