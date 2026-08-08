//! Packs API: persisted, refreshable share bundles.
//!
//! A pack is a named recipe — an ordered ride list + layer options + notes
//! (Docs/plans/2026-07-15-packs-design.md). Publishing builds the `.dingonav`
//! and uploads it to dingodirt.com (docs/plans/2026-08-06-plan-publish-to-
//! dingodirt-design.md); the site owns share links, versioning and
//! moderation. The live link is `<nav>/?b=<share_token>`; re-publishing
//! (refresh) bumps the same site pack, so handed-out links stay live.

use axum::http::StatusCode;
use axum::{
    Json, Router,
    extract::{Extension, Path as AxumPath, Query},
    routing::{get, post},
};
use serde::Deserialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use dingo_export::sanitize;

use super::dingodirt::{self, site_base};
use super::export::{
    ApiError, DingoNavOpts, HeatmapFilters, LayerCoverage, bad_request, build_dingonav,
    default_true, internal, nav_base, percent_encode_component,
};

pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_packs).post(create_pack))
        .route(
            "/{id}",
            get(get_pack).patch(update_pack).delete(delete_pack),
        )
        .route("/{id}/publish", post(publish_pack))
        .route("/{id}/publish-plan", post(publish_plan))
        .route("/{id}/plan-feedback", get(plan_feedback))
        .merge(super::marks::routes())
}

/// Live `?b=` link + site pack page for a published pack.
fn share_urls(share_token: &Option<String>) -> (Option<String>, Option<String>) {
    match share_token {
        Some(t) => (
            Some(format!("{}?b={}", nav_base(), percent_encode_component(t))),
            Some(format!("{}/p/{t}", site_base())),
        ),
        None => (None, None),
    }
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
    recompute_attributes(&mut tx, id).await?;
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
        recompute_attributes(&mut tx, id).await?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "updated": id })))
}

/// Refresh the pack's cached filter attributes (locality arrays, start/end
/// singles, HR/speed booleans) after any membership change. The logic lives
/// in the recompute_pack_attributes SQL function so the migration backfill
/// and this path cannot drift.
async fn recompute_attributes(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    pack_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query("SELECT recompute_pack_attributes($1)")
        .bind(pack_id)
        .execute(&mut **tx)
        .await
        .map_err(internal)?;
    Ok(())
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
        SELECT p.id, p.name, p.description, p.share_token, p.site_visibility,
               p.published_at, p.published_bytes, p.revision,
               (SELECT count(*) FROM pack_rides pr WHERE pr.pack_id = p.id) AS ride_count,
               {STALE_SQL} AS stale
        FROM packs p
        ORDER BY p.created_at DESC
        "#
    ))
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let packs: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let share_token: Option<String> = r.get("share_token");
            let (share_url, file_url) = share_urls(&share_token);
            serde_json::json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "description": r.get::<String, _>("description"),
                "published_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("published_at"),
                "published_bytes": r.get::<Option<i64>, _>("published_bytes"),
                "revision": r.get::<i32, _>("revision"),
                "ride_count": r.get::<i64, _>("ride_count"),
                "stale": r.get::<bool, _>("stale"),
                "visibility": r.get::<Option<String>, _>("site_visibility"),
                "share_url": share_url,
                "file_url": file_url,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "packs": packs })))
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

    let share_token: Option<String> = row.get("share_token");
    let (share_url, file_url) = share_urls(&share_token);
    Ok(Json(serde_json::json!({
        "id": row.get::<Uuid, _>("id"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<String, _>("description"),
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
        "published_at": row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("published_at"),
        "published_bytes": row.get::<Option<i64>, _>("published_bytes"),
        "revision": row.get::<i32, _>("revision"),
        "stale": row.get::<bool, _>("stale"),
        "visibility": row.get::<Option<String>, _>("site_visibility"),
        "share_url": share_url,
        "file_url": file_url,
        "ride_name": row.get::<Option<String>, _>("ride_name"),
        "plan_url": row
            .get::<Option<String>, _>("plan_share_token")
            .map(|t| format!("{}/p/{t}", dingodirt::site_base())),
        "rides": rides,
    })))
}

// ---- Publish / refresh ----

#[derive(Debug, Default, Deserialize)]
struct PublishBody {
    /// "unlisted" (link only) or "public" (site review queue). Omitted —
    /// the refresh buttons — keeps the site pack's current visibility, so a
    /// refresh can never demote an approved public pack.
    #[serde(default)]
    visibility: Option<String>,
}

/// Build the pack's `.dingonav` and upload it to dingodirt.com. First publish
/// creates the site pack (share token minted there); every later call is a
/// version bump of the same pack — live `?b=` links pick the new content up.
async fn publish_pack(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
    body: Option<Json<PublishBody>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(publish) = body.unwrap_or_default();
    if let Some(v) = &publish.visibility {
        if v != "unlisted" && v != "public" {
            return Err(bad_request("visibility must be 'unlisted' or 'public'"));
        }
    }
    let token = dingodirt::require_token(&pool).await?;
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

    // Upload. The bundle's filename carries the display name — the site
    // derives the pack name from it / bundle.json; site_pack_id pins the
    // version bump so a rename here updates the site pack instead of
    // forking a new one.
    let site_pack_id: Option<String> = row.get("site_pack_id");
    let site = dingodirt::upload_pack(
        &token,
        &format!("{bundle_name}.dingonav"),
        build.zip.clone(),
        publish.visibility.as_deref(),
        site_pack_id.as_deref(),
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE packs SET site_pack_id = $2, share_token = $3, site_visibility = $4,
               published_at = now(), published_bytes = $5, revision = $6, ride_name = $7
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(&site.id)
    .bind(&site.share_token)
    .bind(&site.visibility)
    .bind(build.zip.len() as i64)
    .bind(revision)
    .bind(&ride_name)
    .execute(&pool)
    .await
    .map_err(internal)?;

    let (share_url, file_url) = share_urls(&Some(site.share_token.clone()));
    let m = &build.manifest;
    Ok(Json(serde_json::json!({
        "share_url": share_url,
        "file_url": file_url,
        "share_token": site.share_token,
        "visibility": site.visibility,
        "site_version": site.version,
        "replaced": !site.is_new,
        "bytes": build.zip.len(),
        "revision": revision,
        "manifest": m,
    })))
}

/// Publish a lightweight planning doc (`.dingoplan`) to the site: simplified
/// track geometry + metadata + accommodation marks, no tiles. This is the
/// shared high-level view the group picks tracks from
/// (docs/plans/2026-08-07-planning-mode-design.md). Separate site pack from
/// the full ride pack; a pack can have both.
async fn publish_plan(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
    body: Option<Json<PublishBody>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(publish) = body.unwrap_or_default();
    if let Some(v) = &publish.visibility {
        if v != "unlisted" && v != "public" {
            return Err(bad_request("visibility must be 'unlisted' or 'public'"));
        }
    }
    let token = dingodirt::require_token(&pool).await?;
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
    let privacy: bool = row.get("privacy");

    // Tier-10 simplification (same tolerance as the web map's zoomed-out
    // tier) over privacy-trimmed geometry: high-level shapes, tiny payload.
    let rows = sqlx::query(
        r#"
        SELECT t.id, t.name, t.grade, t.mode, t.kind, t.region, t.state,
               t.description, t.started_at,
               ST_Length(t.g::geography) AS distance_m,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(t.g, 0.002), 4) AS geometry
        FROM (
            SELECT r.id, r.name, r.grade, r.mode::text AS mode,
                   r.kind::text AS kind, r.region, r.state, r.description,
                   r.started_at,
                   CASE WHEN $2 THEN
                       ST_Difference(r.cleaned_geometry,
                           COALESCE((SELECT ST_Union(boundary) FROM privacy_zones),
                                    ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)))
                   ELSE r.cleaned_geometry END AS g
            FROM rides r
            WHERE r.id = ANY($1) AND r.cleaned_geometry IS NOT NULL
              AND r.superseded_by IS NULL
        ) t
        ORDER BY array_position($1, t.id)
        "#,
    )
    .bind(&ride_ids)
    .bind(privacy)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let mut tracks = Vec::new();
    for r in &rows {
        let Some(geom) = r.get::<Option<String>, _>("geometry") else { continue };
        let Ok(geometry) = serde_json::from_str::<serde_json::Value>(&geom) else { continue };
        let km = r
            .get::<Option<f64>, _>("distance_m")
            .map(|m| (m / 1000.0).round())
            .unwrap_or(0.0);
        tracks.push(serde_json::json!({
            "id": r.get::<Uuid, _>("id").to_string(),
            "name": r.get::<Option<String>, _>("name").unwrap_or_else(|| "Unnamed ride".into()),
            "km": km,
            "grade": r.get::<Option<String>, _>("grade"),
            "mode": r.get::<Option<String>, _>("mode"),
            "kind": r.get::<Option<String>, _>("kind"),
            "region": r.get::<Option<String>, _>("region"),
            "state": r.get::<Option<String>, _>("state"),
            "description": r.get::<Option<String>, _>("description"),
            "started_at": r
                .get::<Option<chrono::DateTime<chrono::Utc>>, _>("started_at")
                .map(|t| t.to_rfc3339()),
            "geometry": geometry,
        }));
    }
    if tracks.is_empty() {
        return Err(bad_request("no publishable tracks — every ride is empty or superseded"));
    }

    // Accommodation/POI marks only — turn cues are nav noise at this scale.
    let marks: Vec<serde_json::Value> = super::marks::accepted_marks(&pool, id)
        .await?
        .into_iter()
        .filter(|m| m.op == "add" && m.kind.as_deref().is_some_and(|k| k != "turn"))
        .map(|m| {
            let kind = m.kind.unwrap_or_default();
            let icon = match kind.as_str() {
                "camp" => "⛺",
                "fuel" => "⛽",
                "water" => "💧",
                "pub" | "food" => "🍺",
                _ => "📍",
            };
            serde_json::json!({
                "id": m.id,
                "name": kind,
                "icon": icon,
                "lon": m.lo,
                "lat": m.la,
            })
        })
        .collect();

    let doc = serde_json::json!({
        "format": "dingoplan",
        "schemaVersion": 1,
        "name": name,
        "description": row.get::<Option<String>, _>("description"),
        "tracks": tracks,
        "marks": marks,
    });
    let bytes = serde_json::to_vec(&doc).map_err(internal)?;

    // First plan publish defaults to unlisted — a private plan page is
    // useless to the group and the 404 it produces reads as a bug.
    let site_plan_id: Option<String> = row.get("site_plan_id");
    let visibility = publish
        .visibility
        .as_deref()
        .or(if site_plan_id.is_none() { Some("unlisted") } else { None });
    let bytes_len = bytes.len();
    let site = dingodirt::upload_pack(
        &token,
        &format!("{bundle_name}.dingoplan"),
        bytes,
        visibility,
        site_plan_id.as_deref(),
    )
    .await?;

    sqlx::query(
        "UPDATE packs SET site_plan_id = $2, plan_share_token = $3 WHERE id = $1",
    )
    .bind(id)
    .bind(&site.id)
    .bind(&site.share_token)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Json(serde_json::json!({
        "plan_url": format!("{}/p/{}", dingodirt::site_base(), site.share_token),
        "share_token": site.share_token,
        "visibility": site.visibility,
        "site_version": site.version,
        "replaced": !site.is_new,
        "bytes": bytes_len,
        "tracks": tracks.len(),
        "marks": marks.len(),
    })))
}

/// Group votes/comments from the pack's planning page, keyed
/// `track:<ride_id>` / `mark:<id>` — Plan shows tallies per ride so the
/// shortlist can be trimmed where the group already decided.
async fn plan_feedback(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query("SELECT plan_share_token FROM packs WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, format!("no pack {id}")))?;
    let token: Option<String> = row.get("plan_share_token");
    let Some(token) = token else {
        return Err(bad_request("no plan published for this pack"));
    };
    let items = dingodirt::plan_feedback(&token).await?;
    Ok(Json(serde_json::json!({ "items": items })))
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
    let row = sqlx::query("SELECT site_pack_id FROM packs WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, format!("no pack {id}")))?;
    let site_pack_id: Option<String> = row.get("site_pack_id");

    // Soft-delete on the site kills the ?b= link immediately (blobs linger
    // 30 days server-side). A real site failure blocks the local delete so
    // the pack doesn't quietly stay live under a link Plan forgot about.
    let mut unpublished = false;
    if q.unpublish {
        if let Some(site_id) = &site_pack_id {
            let token = dingodirt::require_token(&pool).await?;
            dingodirt::delete_site_pack(&token, site_id).await?;
            unpublished = true;
        }
    }
    sqlx::query("DELETE FROM packs WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "deleted": id, "unpublished": unpublished })))
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
