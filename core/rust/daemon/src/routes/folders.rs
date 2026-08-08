//! Folders API: the user-managed single-home tree behind the Folder pill
//! (docs/plans/plan-2026-08-07-list-filter-pills-design.md).
//!
//! NULL folder_id = root ("Unfiled"). Deleting a folder cascades to child
//! folders; filed items fall back to Unfiled (SET NULL), never deleted.

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
        .route("/", get(list_folders).post(create_folder))
        .route("/{id}", axum::routing::patch(update_folder).delete(delete_folder))
        .route("/assign", post(assign_items))
}

/// Flat rows with parent ids + direct item counts; the client folds them
/// into the tree (same pattern as the location facets).
async fn list_folders(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows = sqlx::query(
        r#"
        SELECT fo.id, fo.name, fo.parent_id, fo.position,
               (SELECT count(*) FROM rides r
                WHERE r.folder_id = fo.id AND r.superseded_by IS NULL) AS ride_count,
               (SELECT count(*) FROM packs p WHERE p.folder_id = fo.id) AS pack_count
        FROM folders fo
        ORDER BY fo.position, fo.name
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    let folders: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "parent_id": r.get::<Option<Uuid>, _>("parent_id"),
                "position": r.get::<i32, _>("position"),
                "ride_count": r.get::<i64, _>("ride_count"),
                "pack_count": r.get::<i64, _>("pack_count"),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "folders": folders })))
}

#[derive(Debug, Deserialize)]
struct FolderInput {
    name: String,
    parent_id: Option<Uuid>,
}

async fn create_folder(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<FolderInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("folder name must not be empty"));
    }
    let row = sqlx::query(
        "INSERT INTO folders (name, parent_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(name)
    .bind(body.parent_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref d) if d.constraint().is_some() => {
            bad_request("a folder with that name already exists here")
        }
        other => internal(other),
    })?;
    Ok(Json(serde_json::json!({ "id": row.get::<Uuid, _>("id") })))
}

/// PATCH body: absent fields stay unchanged. `parent_id` moves the folder;
/// `{"parent_id": null}` moves it to the root — send the field explicitly.
#[derive(Debug, Deserialize)]
struct FolderPatch {
    name: Option<String>,
    /// Two-level Option: outer absent = no move, inner None = move to root.
    #[serde(default, deserialize_with = "deserialize_some")]
    parent_id: Option<Option<Uuid>>,
    position: Option<i32>,
}

/// Distinguish an absent field (outer None via `default`) from an explicit
/// JSON null (inner None): any present value — null included — lands here.
fn deserialize_some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(d).map(Some)
}

async fn update_folder(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
    Json(body): Json<FolderPatch>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(name) = &body.name {
        if name.trim().is_empty() {
            return Err(bad_request("folder name must not be empty"));
        }
    }
    if let Some(Some(new_parent)) = body.parent_id {
        if new_parent == id {
            return Err(bad_request("a folder cannot be its own parent"));
        }
        // Reject moves into the folder's own subtree — that would orphan it.
        let in_subtree: bool = sqlx::query_scalar(
            r#"
            WITH RECURSIVE sub(id) AS (
                SELECT id FROM folders WHERE id = $1
                UNION ALL
                SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
            )
            SELECT EXISTS(SELECT 1 FROM sub WHERE id = $2)
            "#,
        )
        .bind(id)
        .bind(new_parent)
        .fetch_one(&pool)
        .await
        .map_err(internal)?;
        if in_subtree {
            return Err(bad_request("cannot move a folder into its own subtree"));
        }
    }
    let res = match body.parent_id {
        Some(parent) => sqlx::query(
            "UPDATE folders SET name = COALESCE($2, name), parent_id = $3, \
             position = COALESCE($4, position) WHERE id = $1",
        )
        .bind(id)
        .bind(body.name.as_deref().map(str::trim))
        .bind(parent)
        .bind(body.position)
        .execute(&pool)
        .await,
        None => sqlx::query(
            "UPDATE folders SET name = COALESCE($2, name), \
             position = COALESCE($3, position) WHERE id = $1",
        )
        .bind(id)
        .bind(body.name.as_deref().map(str::trim))
        .bind(body.position)
        .execute(&pool)
        .await,
    }
    .map_err(|e| match e {
        sqlx::Error::Database(ref d) if d.constraint().is_some() => {
            bad_request("a folder with that name already exists here")
        }
        other => internal(other),
    })?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no folder {id}")));
    }
    Ok(Json(serde_json::json!({ "updated": id })))
}

async fn delete_folder(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let res = sqlx::query("DELETE FROM folders WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(internal)?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, format!("no folder {id}")));
    }
    Ok(Json(serde_json::json!({ "deleted": id })))
}

/// File items into a folder (or back to Unfiled with `"folder_id": null`).
#[derive(Debug, Deserialize)]
struct AssignInput {
    /// 'ride' | 'pack'
    item_type: String,
    ids: Vec<Uuid>,
    folder_id: Option<Uuid>,
}

async fn assign_items(
    Extension(pool): Extension<PgPool>,
    Json(body): Json<AssignInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.ids.is_empty() {
        return Err(bad_request("no item ids"));
    }
    if let Some(fid) = body.folder_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM folders WHERE id = $1)")
                .bind(fid)
                .fetch_one(&pool)
                .await
                .map_err(internal)?;
        if !exists {
            return Err(bad_request("unknown folder_id"));
        }
    }
    let table = match body.item_type.as_str() {
        "ride" => "rides",
        "pack" => "packs",
        _ => return Err(bad_request("item_type must be 'ride' or 'pack'")),
    };
    let res = sqlx::query(&format!(
        "UPDATE {table} SET folder_id = $1 WHERE id = ANY($2)"
    ))
    .bind(body.folder_id)
    .bind(&body.ids)
    .execute(&pool)
    .await
    .map_err(internal)?;
    Ok(Json(serde_json::json!({ "filed": res.rows_affected() })))
}
