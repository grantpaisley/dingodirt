//! Labelsets API: multi-membership labels on top of folders
//! (docs/plans/plan-2026-08-07-list-filter-pills-design.md, "Future").
//!
//! Each label set is one filter dimension (`labelset:<id>` in the
//! registry); labels nest like folders. item_labels is polymorphic over
//! rides and packs — no FK to the item tables, so a hard-deleted item can
//! leave orphan rows; queries always join back to the live item table, so
//! orphans are invisible and harmless.

use axum::http::StatusCode;
use axum::{
    Json, Router,
    extract::{Extension, Path},
    routing::{get, post},
};
use serde::Deserialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::export::{ApiError, bad_request, internal};

pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_labels).post(create_label))
        .route("/sets", post(create_set))
        .route("/sets/{id}", axum::routing::patch(update_set).delete(delete_set))
        .route("/{id}", axum::routing::patch(update_label).delete(delete_label))
        .route("/assign", post(assign_labels))
}

/// Everything the pill UI needs in one call: the sets and a flat label
/// list with parent ids + direct item counts (the client folds the tree,
/// same pattern as folders).
async fn list_labels(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let sets = sqlx::query("SELECT id, name FROM label_sets ORDER BY name")
        .fetch_all(&pool)
        .await
        .map_err(internal)?;
    let labels = sqlx::query(
        r#"
        SELECT l.id, l.label_set_id, l.name, l.parent_id, l.position,
               (SELECT count(*) FROM item_labels il WHERE il.label_id = l.id) AS item_count
        FROM labels l
        ORDER BY l.position, l.name
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    Ok(Json(serde_json::json!({
        "sets": sets.iter().map(|r| serde_json::json!({
            "id": r.get::<Uuid, _>("id"),
            "name": r.get::<String, _>("name"),
        })).collect::<Vec<_>>(),
        "labels": labels.iter().map(|r| serde_json::json!({
            "id": r.get::<Uuid, _>("id"),
            "label_set_id": r.get::<Uuid, _>("label_set_id"),
            "name": r.get::<String, _>("name"),
            "parent_id": r.get::<Option<Uuid>, _>("parent_id"),
            "position": r.get::<i32, _>("position"),
            "item_count": r.get::<i64, _>("item_count"),
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Debug, Deserialize)]
struct SetInput {
    name: String,
}

async fn create_set(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<SetInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("label set name must not be empty"));
    }
    let row = sqlx::query("INSERT INTO label_sets (name) VALUES ($1) RETURNING id")
        .bind(name)
        .fetch_one(&pool)
        .await
        .map_err(unique_or_internal("a label set with that name already exists"))?;
    Ok(Json(serde_json::json!({ "id": row.get::<Uuid, _>("id") })))
}

async fn update_set(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
    Json(body): Json<SetInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("label set name must not be empty"));
    }
    let res = sqlx::query("UPDATE label_sets SET name = $2 WHERE id = $1")
        .bind(id)
        .bind(name)
        .execute(&pool)
        .await
        .map_err(unique_or_internal("a label set with that name already exists"))?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no label set {id}")));
    }
    Ok(Json(serde_json::json!({ "updated": id })))
}

/// Deleting a set cascades to its labels and their item links — the items
/// themselves are never touched.
async fn delete_set(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let res = sqlx::query("DELETE FROM label_sets WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(internal)?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no label set {id}")));
    }
    Ok(Json(serde_json::json!({ "deleted": id })))
}

#[derive(Debug, Deserialize)]
struct LabelInput {
    label_set_id: Uuid,
    name: String,
    parent_id: Option<Uuid>,
}

async fn create_label(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<LabelInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("label name must not be empty"));
    }
    if let Some(parent) = body.parent_id {
        let same_set: Option<bool> = sqlx::query_scalar(
            "SELECT label_set_id = $2 FROM labels WHERE id = $1",
        )
        .bind(parent)
        .bind(body.label_set_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?;
        if same_set != Some(true) {
            return Err(bad_request("parent label must exist in the same set"));
        }
    }
    let row = sqlx::query(
        "INSERT INTO labels (label_set_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(body.label_set_id)
    .bind(name)
    .bind(body.parent_id)
    .fetch_one(&pool)
    .await
    .map_err(unique_or_internal("a label with that name already exists here"))?;
    Ok(Json(serde_json::json!({ "id": row.get::<Uuid, _>("id") })))
}

#[derive(Debug, Deserialize)]
struct LabelPatch {
    name: Option<String>,
    /// Outer absent = no move; explicit null = move to the set's root.
    #[serde(default, deserialize_with = "deserialize_some")]
    parent_id: Option<Option<Uuid>>,
    position: Option<i32>,
}

fn deserialize_some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(d).map(Some)
}

async fn update_label(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
    Json(body): Json<LabelPatch>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(name) = &body.name {
        if name.trim().is_empty() {
            return Err(bad_request("label name must not be empty"));
        }
    }
    if let Some(Some(new_parent)) = body.parent_id {
        if new_parent == id {
            return Err(bad_request("a label cannot be its own parent"));
        }
        // Same set + not inside the label's own subtree.
        let ok: Option<bool> = sqlx::query_scalar(
            r#"
            WITH RECURSIVE sub(id) AS (
                SELECT id FROM labels WHERE id = $1
                UNION ALL
                SELECT l.id FROM labels l JOIN sub ON l.parent_id = sub.id
            )
            SELECT p.label_set_id = (SELECT label_set_id FROM labels WHERE id = $1)
                   AND NOT EXISTS (SELECT 1 FROM sub WHERE id = $2)
            FROM labels p WHERE p.id = $2
            "#,
        )
        .bind(id)
        .bind(new_parent)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?;
        if ok != Some(true) {
            return Err(bad_request(
                "parent must be in the same set and outside the label's subtree",
            ));
        }
    }
    let res = match body.parent_id {
        Some(parent) => sqlx::query(
            "UPDATE labels SET name = COALESCE($2, name), parent_id = $3, \
             position = COALESCE($4, position) WHERE id = $1",
        )
        .bind(id)
        .bind(body.name.as_deref().map(str::trim))
        .bind(parent)
        .bind(body.position)
        .execute(&pool)
        .await,
        None => sqlx::query(
            "UPDATE labels SET name = COALESCE($2, name), \
             position = COALESCE($3, position) WHERE id = $1",
        )
        .bind(id)
        .bind(body.name.as_deref().map(str::trim))
        .bind(body.position)
        .execute(&pool)
        .await,
    }
    .map_err(unique_or_internal("a label with that name already exists here"))?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no label {id}")));
    }
    Ok(Json(serde_json::json!({ "updated": id })))
}

async fn delete_label(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let res = sqlx::query("DELETE FROM labels WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(internal)?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no label {id}")));
    }
    Ok(Json(serde_json::json!({ "deleted": id })))
}

/// Add or remove one label on many items. Multi-membership: adding never
/// displaces other labels, and re-adding is a no-op.
#[derive(Debug, Deserialize)]
struct AssignInput {
    /// 'ride' | 'pack'
    item_type: String,
    ids: Vec<Uuid>,
    label_id: Uuid,
    /// true = attach, false = detach
    on: bool,
}

async fn assign_labels(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<AssignInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.ids.is_empty() {
        return Err(bad_request("no item ids"));
    }
    if !matches!(body.item_type.as_str(), "ride" | "pack") {
        return Err(bad_request("item_type must be 'ride' or 'pack'"));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM labels WHERE id = $1)")
        .bind(body.label_id)
        .fetch_one(&pool)
        .await
        .map_err(internal)?;
    if !exists {
        return Err(bad_request("unknown label_id"));
    }
    let affected = if body.on {
        sqlx::query(
            "INSERT INTO item_labels (item_type, item_id, label_id) \
             SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING",
        )
        .bind(&body.item_type)
        .bind(&body.ids)
        .bind(body.label_id)
        .execute(&pool)
        .await
        .map_err(internal)?
        .rows_affected()
    } else {
        sqlx::query(
            "DELETE FROM item_labels WHERE item_type = $1 AND item_id = ANY($2) AND label_id = $3",
        )
        .bind(&body.item_type)
        .bind(&body.ids)
        .bind(body.label_id)
        .execute(&pool)
        .await
        .map_err(internal)?
        .rows_affected()
    };
    Ok(Json(serde_json::json!({ "changed": affected })))
}

/// Map a unique-constraint violation to a friendly 400; everything else 500.
fn unique_or_internal(msg: &'static str) -> impl Fn(sqlx::Error) -> ApiError {
    move |e| match e {
        sqlx::Error::Database(ref d) if d.constraint().is_some() => bad_request(msg),
        other => internal(other),
    }
}
