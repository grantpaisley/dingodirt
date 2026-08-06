//! Packs API: persisted, refreshable share bundles.
//!
//! A pack is a named recipe — an ordered ride list + layer options + notes
//! (Docs/plans/2026-07-15-packs-design.md). Publishing builds the `.dingonav`
//! and commits it to `DINGO_SHARE_REPO` at `shares/<slug>.dingonav`; the live
//! link is `<nav>/?b=<slug>`, which DingoNav resolves against the repo's HEAD,
//! so re-publishing (refresh) updates links already handed out. The slug is
//! frozen at first publish; the display name stays freely editable.

use axum::http::StatusCode;
use axum::{
    Json, Router,
    extract::{Extension, Path as AxumPath, Query},
    routing::{get, post},
};
use serde::Deserialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use dingo_export::{sanitize, sanitize_filename};

use super::export::{
    ApiError, DingoNavOpts, HeatmapFilters, LayerCoverage, bad_request, build_dingonav,
    default_true, gh_api, internal, map_gh_err, nav_base, percent_encode_component, share_repo,
};

pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_packs).post(create_pack))
        .route(
            "/{id}",
            get(get_pack).patch(update_pack).delete(delete_pack),
        )
        .route("/{id}/publish", post(publish_pack))
        .route("/orphans/{file}", axum::routing::delete(delete_orphan))
        .merge(super::marks::routes())
}

// ---- Create / update ----

#[derive(Debug, Deserialize)]
struct PackInput {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    ride_ids: Vec<Uuid>,
    #[serde(default = "default_true")]
    include_tracks: bool,
    #[serde(default)]
    include_heatmap: bool,
    #[serde(default)]
    include_strava: bool,
    #[serde(default)]
    include_basemap: bool,
    #[serde(default)]
    include_satellite: bool,
    #[serde(default)]
    include_hillshade: bool,
    #[serde(default)]
    satellite_zoom: Option<i32>,
    #[serde(default = "default_true")]
    privacy: bool,
    /// Stored verbatim (the web filter-panel state); validated at publish time.
    #[serde(default)]
    heatmap_filters: Option<serde_json::Value>,
    /// Per-layer corridor-vs-rect coverage, stored verbatim; missing keys (and
    /// a NULL column) mean corridor — the default shape.
    #[serde(default)]
    coverage: Option<serde_json::Value>,
}

async fn create_pack(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<PackInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("pack name must not be empty"));
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let row = sqlx::query(
        r#"
        INSERT INTO packs (name, description, include_tracks, include_heatmap, include_strava,
                           include_basemap, include_satellite, include_hillshade,
                           satellite_zoom, privacy, heatmap_filters, coverage)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
        "#,
    )
    .bind(name)
    .bind(body.description.trim())
    .bind(body.include_tracks)
    .bind(body.include_heatmap)
    .bind(body.include_strava)
    .bind(body.include_basemap)
    .bind(body.include_satellite)
    .bind(body.include_hillshade)
    .bind(body.satellite_zoom)
    .bind(body.privacy)
    .bind(&body.heatmap_filters)
    .bind(&body.coverage)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    let id: Uuid = row.get("id");
    insert_rides(&mut tx, id, &body.ride_ids).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "id": id })))
}

/// PATCH body: absent fields are left unchanged; `ride_ids`, when present,
/// REPLACES the whole ordered list (simpler than add/remove/move deltas).
#[derive(Debug, Deserialize)]
struct PackPatch {
    name: Option<String>,
    description: Option<String>,
    ride_ids: Option<Vec<Uuid>>,
    include_tracks: Option<bool>,
    include_heatmap: Option<bool>,
    include_strava: Option<bool>,
    include_basemap: Option<bool>,
    include_satellite: Option<bool>,
    include_hillshade: Option<bool>,
    satellite_zoom: Option<i32>,
    privacy: Option<bool>,
    heatmap_filters: Option<serde_json::Value>,
    coverage: Option<serde_json::Value>,
}

async fn update_pack(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
    Json(body): Json<PackPatch>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(name) = &body.name {
        if name.trim().is_empty() {
            return Err(bad_request("pack name must not be empty"));
        }
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let res = sqlx::query(
        r#"
        UPDATE packs SET
            name              = COALESCE($2, name),
            description       = COALESCE($3, description),
            include_tracks    = COALESCE($4, include_tracks),
            include_heatmap   = COALESCE($5, include_heatmap),
            include_strava    = COALESCE($6, include_strava),
            include_basemap   = COALESCE($7, include_basemap),
            include_satellite = COALESCE($8, include_satellite),
            include_hillshade = COALESCE($9, include_hillshade),
            satellite_zoom    = COALESCE($10, satellite_zoom),
            privacy           = COALESCE($11, privacy),
            heatmap_filters   = COALESCE($12, heatmap_filters),
            coverage          = COALESCE($13, coverage),
            updated_at        = now()
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(body.name.as_deref().map(str::trim))
    .bind(body.description.as_deref().map(str::trim))
    .bind(body.include_tracks)
    .bind(body.include_heatmap)
    .bind(body.include_strava)
    .bind(body.include_basemap)
    .bind(body.include_satellite)
    .bind(body.include_hillshade)
    .bind(body.satellite_zoom)
    .bind(body.privacy)
    .bind(&body.heatmap_filters)
    .bind(&body.coverage)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no pack {id}")));
    }
    if let Some(ride_ids) = &body.ride_ids {
        sqlx::query("DELETE FROM pack_rides WHERE pack_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        insert_rides(&mut tx, id, ride_ids).await?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "updated": id })))
}

/// Insert the ordered membership rows, deduping while keeping first positions.
async fn insert_rides(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    pack_id: Uuid,
    ride_ids: &[Uuid],
) -> Result<(), ApiError> {
    let mut seen = std::collections::HashSet::new();
    let deduped: Vec<Uuid> = ride_ids.iter().copied().filter(|r| seen.insert(*r)).collect();
    for (position, ride_id) in deduped.iter().enumerate() {
        sqlx::query("INSERT INTO pack_rides (pack_id, ride_id, position) VALUES ($1, $2, $3)")
            .bind(pack_id)
            .bind(ride_id)
            .bind(position as i32)
            .execute(&mut **tx)
            .await
            .map_err(|e| bad_request(format!("bad ride list: {e}")))?;
    }
    Ok(())
}

// ---- List / detail ----

/// A pack is stale when the recipe changed after the last publish, or any
/// member ride was re-imported / re-cleaned / re-enriched / superseded since.
const STALE_SQL: &str = r#"
    CASE WHEN p.published_at IS NULL THEN false ELSE
        p.updated_at > p.published_at OR EXISTS (
            SELECT 1 FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
            WHERE pr.pack_id = p.id AND (
                r.superseded_by IS NOT NULL
                OR GREATEST(r.imported_at, COALESCE(r.cleaned_at, r.imported_at),
                            COALESCE(r.enriched_at, r.imported_at)) > p.published_at)
        )
    END
"#;

async fn list_packs(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows = sqlx::query(&format!(
        r#"
        SELECT p.id, p.name, p.description, p.slug, p.published_at, p.published_bytes, p.revision,
               (SELECT count(*) FROM pack_rides pr WHERE pr.pack_id = p.id) AS ride_count,
               {STALE_SQL} AS stale
        FROM packs p
        ORDER BY p.created_at DESC
        "#
    ))
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let nav = nav_base();
    let repo = share_repo().ok();
    let packs: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let slug: Option<String> = r.get("slug");
            let published: Option<chrono::DateTime<chrono::Utc>> = r.get("published_at");
            let share_url = match (&slug, published) {
                (Some(s), Some(_)) => {
                    Some(format!("{nav}?b={}", percent_encode_component(s)))
                }
                _ => None,
            };
            let file_url = match (&slug, published, &repo) {
                (Some(s), Some(_), Some(repo)) => {
                    Some(format!("https://github.com/{repo}/blob/HEAD/shares/{s}.dingonav"))
                }
                _ => None,
            };
            serde_json::json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "description": r.get::<String, _>("description"),
                "slug": slug,
                "published_at": published,
                "published_bytes": r.get::<Option<i64>, _>("published_bytes"),
                "revision": r.get::<i32, _>("revision"),
                "ride_count": r.get::<i64, _>("ride_count"),
                "stale": r.get::<bool, _>("stale"),
                "share_url": share_url,
                "file_url": file_url,
            })
        })
        .collect();

    // Orphans: repo files no pack claims (pre-packs shares). Best-effort — a
    // missing repo/gh must not break the list, so errors are reported inline.
    let mut orphans: Vec<serde_json::Value> = Vec::new();
    let mut repo_error: Option<String> = None;
    match share_repo() {
        Err((_, msg)) => repo_error = Some(msg),
        Ok(repo) => {
            let slugs: std::collections::HashSet<String> = rows
                .iter()
                .filter_map(|r| r.get::<Option<String>, _>("slug"))
                .collect();
            match gh_api("GET", &format!("/repos/{repo}/contents/shares"), None).await {
                Ok(serde_json::Value::Array(files)) => {
                    for f in &files {
                        let Some(file) = f.get("name").and_then(|n| n.as_str()) else { continue };
                        let Some(stem) = file.strip_suffix(".dingonav") else { continue };
                        if slugs.contains(stem) {
                            continue;
                        }
                        orphans.push(serde_json::json!({
                            "name": stem,
                            "file": file,
                            "bytes": f.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                            "share_url": format!("{nav}?b={}", percent_encode_component(stem)),
                            "file_url": format!("https://github.com/{repo}/blob/HEAD/shares/{file}"),
                        }));
                    }
                }
                Ok(_) => {}
                Err(e) if e.contains("404") || e.contains("Not Found") => {}
                Err(e) => repo_error = Some(e),
            }
        }
    }

    Ok(Json(serde_json::json!({
        "packs": packs,
        "orphans": orphans,
        "repo_error": repo_error,
    })))
}

async fn get_pack(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query(&format!(
        r#"
        SELECT p.*, {STALE_SQL} AS stale FROM packs p WHERE p.id = $1
        "#
    ))
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or((StatusCode::NOT_FOUND, format!("no pack {id}")))?;

    // Ordered membership, with why-this-won't-publish flags for the UI.
    let rides = sqlx::query(
        r#"
        SELECT r.id, r.name, r.started_at,
               (r.superseded_by IS NOT NULL) AS superseded,
               (r.cleaned_geometry IS NULL) AS no_geometry
        FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
        WHERE pr.pack_id = $1
        ORDER BY pr.position
        "#,
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    let rides: Vec<serde_json::Value> = rides
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<Option<String>, _>("name").unwrap_or_else(|| "Unnamed ride".into()),
                "started_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("started_at"),
                "superseded": r.get::<bool, _>("superseded"),
                "no_geometry": r.get::<bool, _>("no_geometry"),
            })
        })
        .collect();

    let nav = nav_base();
    let slug: Option<String> = row.get("slug");
    let published: Option<chrono::DateTime<chrono::Utc>> = row.get("published_at");
    let share_url = match (&slug, published) {
        (Some(s), Some(_)) => Some(format!("{nav}?b={}", percent_encode_component(s))),
        _ => None,
    };
    Ok(Json(serde_json::json!({
        "id": row.get::<Uuid, _>("id"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<String, _>("description"),
        "slug": slug,
        "include_tracks": row.get::<bool, _>("include_tracks"),
        "include_heatmap": row.get::<bool, _>("include_heatmap"),
        "include_strava": row.get::<bool, _>("include_strava"),
        "include_basemap": row.get::<bool, _>("include_basemap"),
        "include_satellite": row.get::<bool, _>("include_satellite"),
        "include_hillshade": row.get::<bool, _>("include_hillshade"),
        "satellite_zoom": row.get::<Option<i32>, _>("satellite_zoom"),
        "privacy": row.get::<bool, _>("privacy"),
        "heatmap_filters": row.get::<Option<serde_json::Value>, _>("heatmap_filters"),
        "coverage": row.get::<Option<serde_json::Value>, _>("coverage"),
        "published_at": published,
        "published_bytes": row.get::<Option<i64>, _>("published_bytes"),
        "revision": row.get::<i32, _>("revision"),
        "stale": row.get::<bool, _>("stale"),
        "share_url": share_url,
        "ride_name": row.get::<Option<String>, _>("ride_name"),
        "rides": rides,
    })))
}

// ---- Publish / refresh ----

/// Build the pack's `.dingonav` and commit it to `shares/<slug>.dingonav` in
/// `DINGO_SHARE_REPO`. First publish freezes the slug from the current name
/// (409 when a pack or an existing repo file already owns it); every later
/// call is a refresh — same path, new content, live `?b=` links pick it up.
async fn publish_pack(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repo = share_repo()?;
    let row = sqlx::query("SELECT * FROM packs WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, format!("no pack {id}")))?;
    let ride_ids: Vec<Uuid> = sqlx::query(
        "SELECT ride_id FROM pack_rides WHERE pack_id = $1 ORDER BY position",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?
    .iter()
    .map(|r| r.get("ride_id"))
    .collect();
    if ride_ids.is_empty() {
        return Err(bad_request("pack has no tracks — add rides before publishing"));
    }

    let name: String = row.get("name");
    let bundle_name = sanitize(name.trim());
    let heatmap_filters: Option<HeatmapFilters> = row
        .get::<Option<serde_json::Value>, _>("heatmap_filters")
        .and_then(|v| serde_json::from_value(v).ok());
    // NULL / unparseable → all-corridor, the default shape.
    let coverage: LayerCoverage = row
        .get::<Option<serde_json::Value>, _>("coverage")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Slug: frozen once set; derived from the name on first publish.
    let existing_slug: Option<String> = row.get("slug");
    let slug = match &existing_slug {
        Some(s) => s.clone(),
        None => {
            let s = sanitize_filename(&bundle_name).replace([' ', '.'], "-");
            let s = if s.is_empty() { "pack".to_string() } else { s };
            let taken = sqlx::query("SELECT 1 AS one FROM packs WHERE slug = $1 AND id <> $2")
                .bind(&s)
                .bind(id)
                .fetch_optional(&pool)
                .await
                .map_err(internal)?
                .is_some();
            let orphan_taken = gh_api(
                "GET",
                &format!("/repos/{repo}/contents/shares/{s}.dingonav"),
                None,
            )
            .await
            .is_ok();
            if taken || orphan_taken {
                return Err((
                    StatusCode::CONFLICT,
                    format!("share name '{s}' is already taken — rename the pack first"),
                ));
            }
            s
        }
    };

    // Ride name (group channel): minted at first publish, frozen forever —
    // re-deriving would move the group to a new ntfy topic mid-conversation.
    let ride_name = match row.get::<Option<String>, _>("ride_name") {
        Some(rn) => rn,
        None => {
            use chrono::Datelike;
            super::marks::mint_ride_name(&name, chrono::Local::now().year())
        }
    };

    // Best-effort straggler harvest before baking: a dead ntfy must never
    // block a publish, so errors just log and the accepted set ships as-is.
    match super::marks::poll_ntfy(&super::marks::mark_topic(&ride_name)).await {
        Ok(edits) => {
            if let Err((_, e)) = super::marks::upsert_marks(&pool, id, edits).await {
                tracing::warn!("pre-publish mark harvest failed to store: {e}");
            }
        }
        Err(e) => tracing::warn!("pre-publish mark harvest skipped: {e}"),
    }
    let mut marks = super::marks::accepted_marks(&pool, id).await?;
    // Merge in the bundled rides' derived turn cues (shared junction marks).
    // Rider-authored marks win: a derived cue within ~30 m with the same dir
    // is dropped as a duplicate of the rider's.
    match derived_turn_marks(&pool, &ride_ids, row.get("privacy")).await {
        Ok(derived) => {
            let cues = derived
                .into_iter()
                .filter(|d| {
                    !marks.iter().any(|m| {
                        m.dir == d.dir
                            && haversine_m(m.la, m.lo, d.la, d.lo) <= 30.0
                    })
                })
                .collect::<Vec<_>>();
            marks.extend(cues);
        }
        Err(e) => tracing::warn!("derived turn-cue merge skipped: {e}"),
    }

    // Each publish mints the next revision; the bundle carries it so DingoNav
    // can show which version a rider's refresh landed on.
    let revision: i32 = row.get::<i32, _>("revision") + 1;
    let opts = DingoNavOpts {
        include_tracks: row.get("include_tracks"),
        include_heatmap: row.get("include_heatmap"),
        include_strava: row.get("include_strava"),
        include_basemap: row.get("include_basemap"),
        include_satellite: row.get("include_satellite"),
        include_hillshade: row.get("include_hillshade"),
        satellite_zoom: row.get::<Option<i32>, _>("satellite_zoom").map(|z| z as u32),
        heatmap_filters,
        coverage,
        privacy: row.get("privacy"),
        description: row.get::<String, _>("description"),
        revision,
        ride_name: Some(ride_name.clone()),
        marks,
    };
    let build = build_dingonav(&pool, &ride_ids, &bundle_name, &opts).await?;

    // Upload: with DINGO_SHARE_CLONE set (path to a local clone of the share
    // repo), the bundle is committed and pushed through git — the contents
    // API rejects payloads past ~40 MB of file, while git takes files to
    // 100 MB. Without the env, the old contents-API PUT. Either way, old
    // links pinned to a commit sha stay readable from git history; `?b=`
    // links track HEAD and pick this up (raw CDN lag is ~5 minutes).
    let path = format!("shares/{slug}.dingonav");
    let replaced = if let Ok(clone) = std::env::var("DINGO_SHARE_CLONE") {
        let (rel, msg, bytes) =
            (path.clone(), format!("publish pack: {bundle_name}"), build.zip.clone());
        tokio::task::spawn_blocking(move || {
            publish_via_clone(std::path::Path::new(&clone), &rel, &bytes, &msg)
        })
        .await
        .map_err(internal)?
        .map_err(|e| bad_request(&format!("share clone push failed: {e}")))?
    } else {
        let existing_sha = gh_api("GET", &format!("/repos/{repo}/contents/{path}"), None)
            .await
            .ok()
            .and_then(|v| v.get("sha").and_then(|s| s.as_str()).map(String::from));
        let content_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &build.zip);
        let mut payload = serde_json::json!({
            "message": format!("publish pack: {bundle_name}"),
            "content": content_b64,
        });
        if let Some(sha) = &existing_sha {
            payload["sha"] = serde_json::json!(sha);
        }
        gh_api("PUT", &format!("/repos/{repo}/contents/{path}"), Some(&payload))
            .await
            .map_err(|e| map_gh_err(e, &repo))?;
        existing_sha.is_some()
    };

    sqlx::query(
        "UPDATE packs SET slug = $2, published_at = now(), published_bytes = $3, revision = $4, ride_name = $5 WHERE id = $1",
    )
    .bind(id)
    .bind(&slug)
    .bind(build.zip.len() as i64)
    .bind(revision)
    .bind(&ride_name)
    .execute(&pool)
    .await
    .map_err(internal)?;

    let nav = nav_base();
    let m = &build.manifest;
    Ok(Json(serde_json::json!({
        "share_url": format!("{nav}?b={}", percent_encode_component(&slug)),
        "file_url": format!("https://github.com/{repo}/blob/HEAD/shares/{slug}.dingonav"),
        "slug": slug,
        "replaced": replaced,
        "bytes": build.zip.len(),
        "revision": revision,
        "manifest": m,
    })))
}

/// Commit + push one file through a local clone of the share repo. The clone
/// is fast-forwarded to origin first (the contents-API path and other
/// machines also write this repo); a dirty clone or a diverged branch is an
/// error rather than anything destructive. Returns whether the file already
/// existed (the "replaced" flag). Blocking — call from spawn_blocking.
fn publish_via_clone(
    clone: &std::path::Path,
    rel_path: &str,
    bytes: &[u8],
    message: &str,
) -> Result<bool, String> {
    if !clone.join(".git").exists() {
        return Err(format!("{} is not a git clone", clone.display()));
    }
    let git = |args: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(clone)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0") // fail, don't hang, on missing auth
            .output()
            .map_err(|e| format!("git not runnable: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(format!(
                "git {}: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    };
    if !git(&["status", "--porcelain"])?.trim().is_empty() {
        return Err("clone has uncommitted changes — commit or stash them first".into());
    }
    git(&["fetch", "origin"])?;
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    git(&["merge", "--ff-only", &format!("origin/{branch}")])?;

    let target = clone.join(rel_path);
    let replaced = target.exists();
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    git(&["add", rel_path])?;
    // Identical bytes re-published → nothing to commit; that's success.
    if git(&["status", "--porcelain"])?.trim().is_empty() {
        return Ok(replaced);
    }
    git(&["commit", "-m", message])?;
    git(&["push", "origin", &branch])?;
    Ok(replaced)
}

// ---- Delete ----

#[derive(Debug, Deserialize)]
struct DeleteQuery {
    #[serde(default)]
    unpublish: bool,
}

async fn delete_pack(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
    Query(q): Query<DeleteQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query("SELECT slug, published_at FROM packs WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, format!("no pack {id}")))?;
    let slug: Option<String> = row.get("slug");
    let published: Option<chrono::DateTime<chrono::Utc>> = row.get("published_at");

    let mut unpublished = false;
    if q.unpublish {
        if let (Some(slug), Some(_)) = (&slug, published) {
            // Best-effort: an already-deleted repo file must not block the row
            // delete, but a real API failure should surface.
            match delete_repo_share(&format!("{slug}.dingonav")).await {
                Ok(_) => unpublished = true,
                Err((StatusCode::NOT_FOUND, _)) => {}
                Err(e) => return Err(e),
            }
        }
    }
    sqlx::query("DELETE FROM packs WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "deleted": id, "unpublished": unpublished })))
}

/// Delete a pre-packs share file no pack claims (read-only orphans in the UI).
async fn delete_orphan(
    AxumPath(file): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if file.contains('/') || file.contains("..") {
        return Err(bad_request("bad share file name"));
    }
    let file = if file.ends_with(".dingonav") { file } else { format!("{file}.dingonav") };
    delete_repo_share(&file).await?;
    Ok(Json(serde_json::json!({ "deleted": file })))
}

/// Remove `shares/<file>` from DINGO_SHARE_REPO. Links already handed out pin
/// a commit sha and stay fetchable from git history; `?b=` links go dead.
async fn delete_repo_share(file: &str) -> Result<(), ApiError> {
    let repo = share_repo()?;
    let meta = gh_api("GET", &format!("/repos/{repo}/contents/shares/{file}"), None)
        .await
        .map_err(|e| {
            if e.contains("404") || e.contains("Not Found") {
                (StatusCode::NOT_FOUND, format!("no share named {file}"))
            } else {
                map_gh_err(e, &repo)
            }
        })?;
    let sha = meta
        .get("sha")
        .and_then(|s| s.as_str())
        .ok_or_else(|| internal("GitHub API returned no blob sha"))?;
    let payload = serde_json::json!({ "message": format!("delete share: {file}"), "sha": sha });
    gh_api("DELETE", &format!("/repos/{repo}/contents/shares/{file}"), Some(&payload))
        .await
        .map_err(|e| map_gh_err(e, &repo))?;
    Ok(())
}

/// The bundled rides' derived turn cues in DingoNav's mark wire shape —
/// deduped per (junction, dir) so two rides making the same movement ship
/// one cue. Rejected junctions never ship; with the pack's privacy flag on,
/// cues inside privacy zones are dropped like the tracks they annotate.
async fn derived_turn_marks(
    pool: &PgPool,
    ride_ids: &[Uuid],
    privacy: bool,
) -> Result<Vec<super::marks::MarkEdit>, String> {
    let rows = sqlx::query(
        r#"
        WITH z AS (SELECT ST_Union(boundary) AS b FROM privacy_zones)
        SELECT DISTINCT ON (l.mark_id, l.dir)
               l.mark_id, l.dir,
               ST_X(m.location) AS lon, ST_Y(m.location) AS lat
        FROM ride_turn_marks l
        JOIN turn_marks m ON m.id = l.mark_id
        WHERE l.ride_id = ANY($1)
          AND m.status = 'active'
          AND NOT ($2 AND (SELECT b FROM z) IS NOT NULL
                   AND ST_Intersects(m.location, (SELECT b FROM z)))
        ORDER BY l.mark_id, l.dir
        "#,
    )
    .bind(ride_ids)
    .bind(privacy)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let t = chrono::Utc::now().timestamp_millis();
    Ok(rows
        .iter()
        .map(|r| {
            let mark_id: Uuid = r.get("mark_id");
            let dir: String = r.get("dir");
            super::marks::MarkEdit {
                id: Some(format!("tm-{}-{dir}", mark_id.simple())),
                op: "add".into(),
                kind: Some("turn".into()),
                dir: Some(dir),
                la: r.get("lat"),
                lo: r.get("lon"),
                t,
                by: Some("dingo".into()),
            }
        })
        .collect())
}

/// Metres between two lat/lon points (haversine) — for rider-vs-derived
/// mark dedupe only.
fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_000.0;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let (dp, dl) = ((lat2 - lat1).to_radians(), (lon2 - lon1).to_radians());
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().atan2((1.0 - a).sqrt())
}
