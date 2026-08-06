//! Area management - geographic regions for organizing rides

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{AreaId, Error, Result};

/// An area representing a geographic region
#[derive(Debug, Clone)]
pub struct Area {
    pub id: AreaId,
    pub parent_id: Option<AreaId>,
    pub name: String,
    pub mode_affinity: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Depth in hierarchy (0 = root, calculated from parent chain)
    pub depth: i32,
}

/// Area with additional stats
#[derive(Debug, Clone)]
pub struct AreaWithStats {
    pub area: Area,
    pub ride_count: i64,
    pub child_count: i64,
}

/// Create a new area from a GeoJSON polygon
pub async fn create_area(
    pool: &PgPool,
    name: &str,
    boundary_geojson: &str,
    parent_id: Option<AreaId>,
    mode_affinity: Option<&str>,
) -> Result<AreaId> {
    let id = AreaId::new();

    sqlx::query(
        r#"
        INSERT INTO areas (id, name, boundary, parent_id, mode_affinity)
        VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, $5)
        "#,
    )
    .bind(id.0)
    .bind(name)
    .bind(boundary_geojson)
    .bind(parent_id.map(|p| p.0))
    .bind(mode_affinity)
    .execute(pool)
    .await?;

    Ok(id)
}

/// Get an area by ID (simple query without CTE)
pub async fn get_area(pool: &PgPool, id: AreaId) -> Result<Option<Area>> {
    let row = sqlx::query(
        r#"
        SELECT id, parent_id, name, mode_affinity, created_at
        FROM areas
        WHERE id = $1
        "#,
    )
    .bind(id.0)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => {
            let area_id: Uuid = r.get("id");
            let parent_id: Option<Uuid> = r.get("parent_id");
            let name: String = r.get("name");
            let mode_affinity: Option<String> = r.get("mode_affinity");
            let created_at: DateTime<Utc> = r.get("created_at");

            // Calculate depth separately
            let depth = calculate_depth(pool, id).await?;

            Ok(Some(Area {
                id: AreaId::from_uuid(area_id),
                parent_id: parent_id.map(AreaId::from_uuid),
                name,
                mode_affinity,
                created_at,
                depth,
            }))
        }
        None => Ok(None),
    }
}

/// Calculate depth of an area in the hierarchy
async fn calculate_depth(pool: &PgPool, id: AreaId) -> Result<i32> {
    let row = sqlx::query(
        r#"
        WITH RECURSIVE depth_calc AS (
            SELECT id, parent_id, 0 as depth
            FROM areas WHERE id = $1
            UNION ALL
            SELECT a.id, a.parent_id, d.depth + 1
            FROM areas a
            JOIN depth_calc d ON a.id = d.parent_id
        )
        SELECT MAX(depth) as max_depth FROM depth_calc
        "#,
    )
    .bind(id.0)
    .fetch_one(pool)
    .await?;

    let depth: Option<i32> = row.get("max_depth");
    Ok(depth.unwrap_or(0))
}

/// List all areas with hierarchy information
pub async fn list_areas(pool: &PgPool) -> Result<Vec<AreaWithStats>> {
    let rows = sqlx::query(
        r#"
        SELECT
            a.id,
            a.parent_id,
            a.name,
            a.mode_affinity,
            a.created_at,
            COALESCE((SELECT COUNT(*) FROM rides r WHERE r.area_id = a.id), 0) as ride_count,
            COALESCE((SELECT COUNT(*) FROM areas child WHERE child.parent_id = a.id), 0) as child_count
        FROM areas a
        ORDER BY a.name
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut areas = Vec::new();
    for r in rows {
        let id: Uuid = r.get("id");
        let parent_id: Option<Uuid> = r.get("parent_id");
        let name: String = r.get("name");
        let mode_affinity: Option<String> = r.get("mode_affinity");
        let created_at: DateTime<Utc> = r.get("created_at");
        let ride_count: i64 = r.get("ride_count");
        let child_count: i64 = r.get("child_count");

        let area_id = AreaId::from_uuid(id);
        let depth = calculate_depth(pool, area_id).await.unwrap_or(0);

        areas.push(AreaWithStats {
            area: Area {
                id: area_id,
                parent_id: parent_id.map(AreaId::from_uuid),
                name,
                mode_affinity,
                created_at,
                depth,
            },
            ride_count,
            child_count,
        });
    }

    // Sort by depth then name
    areas.sort_by(|a, b| {
        a.area
            .depth
            .cmp(&b.area.depth)
            .then_with(|| a.area.name.cmp(&b.area.name))
    });

    Ok(areas)
}

/// Update an area's metadata
pub async fn update_area(
    pool: &PgPool,
    id: AreaId,
    name: Option<&str>,
    parent_id: Option<Option<AreaId>>,
    mode_affinity: Option<Option<&str>>,
) -> Result<()> {
    // Build dynamic update - only update provided fields
    let mut updates = Vec::new();
    let mut param_count = 1;

    if name.is_some() {
        param_count += 1;
        updates.push(format!("name = ${param_count}"));
    }
    if parent_id.is_some() {
        param_count += 1;
        updates.push(format!("parent_id = ${param_count}"));
    }
    if mode_affinity.is_some() {
        param_count += 1;
        updates.push(format!("mode_affinity = ${param_count}"));
    }

    if updates.is_empty() {
        return Ok(());
    }

    let query = format!("UPDATE areas SET {} WHERE id = $1", updates.join(", "));

    let mut q = sqlx::query(&query).bind(id.0);

    if let Some(n) = name {
        q = q.bind(n);
    }
    if let Some(p) = parent_id {
        q = q.bind(p.map(|pid| pid.0));
    }
    if let Some(m) = mode_affinity {
        q = q.bind(m);
    }

    q.execute(pool).await?;

    Ok(())
}

/// Delete an area (children will be cascaded)
pub async fn delete_area(pool: &PgPool, id: AreaId) -> Result<()> {
    let result = sqlx::query!("DELETE FROM areas WHERE id = $1", id.0)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(Error::NotFound(format!("Area {id} not found")));
    }

    Ok(())
}

/// Find the most specific (deepest nested) area containing a point
pub async fn find_area_for_point(pool: &PgPool, lat: f64, lon: f64) -> Result<Option<Area>> {
    // Find all areas containing the point
    let rows = sqlx::query(
        r#"
        SELECT id, parent_id, name, mode_affinity, created_at
        FROM areas
        WHERE ST_Contains(boundary, ST_SetSRID(ST_MakePoint($1, $2), 4326))
        "#,
    )
    .bind(lon)
    .bind(lat)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(None);
    }

    // Find the deepest one
    let mut deepest: Option<Area> = None;
    let mut max_depth = -1;

    for r in rows {
        let id: Uuid = r.get("id");
        let parent_id: Option<Uuid> = r.get("parent_id");
        let name: String = r.get("name");
        let mode_affinity: Option<String> = r.get("mode_affinity");
        let created_at: DateTime<Utc> = r.get("created_at");

        let area_id = AreaId::from_uuid(id);
        let depth = calculate_depth(pool, area_id).await.unwrap_or(0);

        if depth > max_depth {
            max_depth = depth;
            deepest = Some(Area {
                id: area_id,
                parent_id: parent_id.map(AreaId::from_uuid),
                name,
                mode_affinity,
                created_at,
                depth,
            });
        }
    }

    Ok(deepest)
}

/// Get area boundary as GeoJSON
pub async fn get_area_boundary_geojson(pool: &PgPool, id: AreaId) -> Result<Option<String>> {
    let row = sqlx::query!(
        r#"
        SELECT ST_AsGeoJSON(boundary) as geojson
        FROM areas
        WHERE id = $1
        "#,
        id.0
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.and_then(|r| r.geojson))
}
