//! Owner management: list and create owners (me/friend/source/synthetic)

use axum::extract::{Extension, Path};
use axum::{Json, Router, routing::get};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

type ApiError = (axum::http::StatusCode, String);

fn internal(e: impl std::fmt::Display) -> ApiError {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_owners).post(create_owner))
        .route("/{id}", get(get_owner))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Owner {
    pub id: String,
    pub kind: String,
    pub email: Option<String>,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateOwnerRequest {
    /// 'me' | 'friend' | 'source' | 'synthetic'
    pub kind: String,
    /// Required for 'me' and 'friend', null otherwise
    pub email: Option<String>,
    /// Display name; identity key for data sources
    pub name: String,
}

#[axum::debug_handler]
async fn list_owners(
    Extension(pool): Extension<PgPool>,
) -> Result<Json<Vec<Owner>>, ApiError> {
    let owners = sqlx::query_as::<_, (Uuid, String, Option<String>, String)>(
        "SELECT id, kind, email, name FROM owners ORDER BY name"
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?
    .into_iter()
    .map(|(id, kind, email, name)| Owner {
        id: id.to_string(),
        kind,
        email,
        name,
    })
    .collect();
    Ok(Json(owners))
}

#[axum::debug_handler]
async fn get_owner(
    Extension(pool): Extension<PgPool>,
    Path(id): Path<String>,
) -> Result<Json<Owner>, ApiError> {
    let parsed_id = Uuid::parse_str(&id)
        .map_err(|_| (axum::http::StatusCode::BAD_REQUEST, "invalid owner id".into()))?;

    let (owner_id, kind, email, name) = sqlx::query_as::<_, (Uuid, String, Option<String>, String)>(
        "SELECT id, kind, email, name FROM owners WHERE id = $1"
    )
    .bind(parsed_id)
    .fetch_one(&pool)
    .await
    .map_err(|_| (axum::http::StatusCode::NOT_FOUND, "owner not found".into()))?;

    Ok(Json(Owner {
        id: owner_id.to_string(),
        kind,
        email,
        name,
    }))
}

#[axum::debug_handler]
async fn create_owner(
    Extension(pool): Extension<PgPool>,
    Json(req): Json<CreateOwnerRequest>,
) -> Result<Json<Owner>, ApiError> {
    // Validate: kind determines required fields
    if !["me", "friend", "source", "synthetic"].contains(&req.kind.as_str()) {
        return Err((axum::http::StatusCode::BAD_REQUEST, "invalid kind".into()));
    }
    if (req.kind == "me" || req.kind == "friend") && req.email.is_none() {
        return Err((axum::http::StatusCode::BAD_REQUEST, "email required for kind=me/friend".into()));
    }

    let id = Uuid::new_v4();

    // For 'friend' and 'source', check if owner with this email/name already exists
    if req.kind == "friend" {
        let existing = sqlx::query_as::<_, (Uuid,)>(
            "SELECT id FROM owners WHERE kind = 'friend' AND email = $1"
        )
        .bind(&req.email)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?;

        if let Some((existing_id,)) = existing {
            // Return the existing owner instead of creating a duplicate
            return get_owner(Extension(pool), Path(existing_id.to_string())).await;
        }
    } else if req.kind == "source" {
        let existing = sqlx::query_as::<_, (Uuid,)>(
            "SELECT id FROM owners WHERE kind = 'source' AND name = $1"
        )
        .bind(&req.name)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?;

        if let Some((existing_id,)) = existing {
            // Return the existing owner instead of creating a duplicate
            return get_owner(Extension(pool), Path(existing_id.to_string())).await;
        }
    }

    sqlx::query(
        "INSERT INTO owners (id, kind, email, name) VALUES ($1, $2, $3, $4)"
    )
    .bind(id)
    .bind(&req.kind)
    .bind(&req.email)
    .bind(&req.name)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Json(Owner {
        id: id.to_string(),
        kind: req.kind,
        email: req.email,
        name: req.name,
    }))
}
