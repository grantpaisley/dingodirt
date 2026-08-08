//! Unified item query + dimension registry — the server side of the list
//! filter pills (docs/plans/plan-2026-08-07-list-filter-pills-design.md).
//!
//! One registry declares every filter dimension; the UI never knows a
//! virtual dimension (rides/packs columns) from a materialised one (the
//! folders tree). `POST /api/items/query` takes the pill state and returns
//! either the matching items of all three types (track / route / pack) in
//! one shape, or — with `facet` set — one dimension's value list with
//! counts computed against the OTHER active pills.

use axum::{
    Json, Router,
    extract::Extension,
    routing::{get, post},
};
use serde::Deserialize;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use std::collections::HashMap;
use uuid::Uuid;

use super::export::{ApiError, bad_request, internal};

pub fn routes() -> Router {
    Router::new().route("/", get(dimensions))
}

pub fn item_routes() -> Router {
    Router::new().route("/query", post(query_items))
}

/// A ride is a "route" item when it is a planned/curated route or a
/// hand-drawn plan — the same rule the list's class column uses for 'plan',
/// minus the origin facet (ownership is its own dimension).
const IS_ROUTE: &str =
    "(r.kind = 'planned' OR r.track_type = 'route' OR r.started_at IS NULL)";

/// Same loop rule as the ride list: endpoints within 500 m or 2% of length.
const IS_LOOP: &str = "(ST_Distance(ST_StartPoint(r.cleaned_geometry)::geography, \
     ST_EndPoint(r.cleaned_geometry)::geography) \
     < GREATEST(500, ST_Length(r.cleaned_geometry::geography) * 0.02))";

// ---- Registry ----

/// The dimension registry. `kind` drives the pill UI: flat = checkbox list,
/// hierarchical = expandable tree checkable at any level, boolean = the pill
/// itself toggles. Future user labelsets appear here with zero UI change.
async fn dimensions() -> Json<serde_json::Value> {
    Json(serde_json::json!([
        { "id": "type",           "name": "Type",      "kind": "flat" },
        { "id": "owner",          "name": "Owner",     "kind": "flat" },
        { "id": "start_location", "name": "Start",     "kind": "hierarchical" },
        { "id": "end_location",   "name": "End",       "kind": "hierarchical" },
        { "id": "touches",        "name": "Touches",   "kind": "hierarchical" },
        { "id": "folder",         "name": "Folder",    "kind": "hierarchical" },
        { "id": "has_hr",         "name": "Has HR",    "kind": "boolean" },
        { "id": "has_speed",      "name": "Has speed", "kind": "boolean" },
        { "id": "is_loop",        "name": "Is loop",   "kind": "boolean" },
    ]))
}

// ---- Query shapes ----

#[derive(Debug, Deserialize)]
pub struct PillFilter {
    pub dimension: String,
    /// Checked values. Flat: strings. Hierarchical: string arrays (a path
    /// prefix — checking a node matches everything beneath it). Boolean
    /// pills ignore values (their presence is the filter). A zero-checked
    /// pill is inactive and matches everything.
    #[serde(default)]
    pub values: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ItemsQuery {
    #[serde(default)]
    pub filters: Vec<PillFilter>,
    /// Search pills: each string ANDs with everything else; within one
    /// string, whitespace-separated terms all must match.
    #[serde(default)]
    pub search: Vec<String>,
    /// Optional viewport restriction: "minLon,minLat,maxLon,maxLat"
    pub bounds: Option<String>,
    /// Return this dimension's faceted value list instead of items.
    pub facet: Option<String>,
    pub limit: Option<i64>,
}

const KNOWN_DIMENSIONS: [&str; 9] = [
    "type", "owner", "start_location", "end_location", "touches", "folder",
    "has_hr", "has_speed", "is_loop",
];

/// AND-combined filters; values within one pill OR together.
async fn query_items(
    Extension(pool): Extension<PgPool>,
    Json(q): Json<ItemsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    for f in &q.filters {
        if !KNOWN_DIMENSIONS.contains(&f.dimension.as_str()) {
            return Err(bad_request(format!("unknown dimension '{}'", f.dimension)));
        }
    }
    match q.facet.as_deref() {
        Some(dim) => facet(&pool, &q, dim).await,
        None => items(&pool, &q).await,
    }
}

// ---- Clause builders ----

/// Which item types a `type` pill admits; no type pill admits all three.
fn type_selection(filters: &[PillFilter]) -> (bool, bool, bool) {
    let pill = filters.iter().find(|f| f.dimension == "type" && !f.values.is_empty());
    match pill {
        None => (true, true, true),
        Some(p) => {
            let has = |v: &str| p.values.iter().any(|x| x.as_str() == Some(v));
            (has("track"), has("route"), has("pack"))
        }
    }
}

fn str_values(f: &PillFilter) -> Vec<String> {
    f.values.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

fn path_values(f: &PillFilter) -> Vec<Vec<String>> {
    f.values
        .iter()
        .filter_map(|v| {
            let arr = v.as_array()?;
            let path: Vec<String> =
                arr.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect();
            (path.len() == arr.len() && !path.is_empty()).then_some(path)
        })
        .collect()
}

/// Push the recursive-subtree folder membership clause for `col`.
/// "unfiled" is the NULL home; a folder id matches its whole subtree.
fn push_folder_clause(qb: &mut QueryBuilder<'_, Postgres>, col: &str, values: &[String]) {
    let ids: Vec<Uuid> = values.iter().filter_map(|v| Uuid::parse_str(v).ok()).collect();
    let unfiled = values.iter().any(|v| v == "unfiled");
    qb.push(" AND (");
    if unfiled {
        qb.push(format!("{col} IS NULL"));
        if !ids.is_empty() {
            qb.push(" OR ");
        }
    } else if ids.is_empty() {
        // A folder pill whose every value failed to parse matches nothing —
        // never everything.
        qb.push("FALSE");
    }
    if !ids.is_empty() {
        qb.push(format!(
            "{col} IN (WITH RECURSIVE sub(id) AS (SELECT id FROM folders WHERE id = ANY("
        ));
        qb.push_bind(ids);
        qb.push(
            "::uuid[]) UNION ALL SELECT f2.id FROM folders f2 JOIN sub ON f2.parent_id = sub.id) \
             SELECT id FROM sub)",
        );
    }
    qb.push(")");
}

/// Location-path OR group over 4-level COALESCE columns. `cols` maps the
/// path level to the SQL expression for that level. Checking a node at any
/// level matches everything beneath it — a path is a prefix, so a shorter
/// path simply constrains fewer levels.
fn push_location_clause(
    qb: &mut QueryBuilder<'_, Postgres>,
    cols: [&str; 4],
    paths: &[Vec<String>],
) {
    qb.push(" AND (");
    let mut first = true;
    for path in paths {
        if !first {
            qb.push(" OR ");
        }
        first = false;
        qb.push("(");
        for (i, part) in path.iter().take(4).enumerate() {
            if i > 0 {
                qb.push(" AND ");
            }
            qb.push(format!("COALESCE({}, 'Unknown') = ", cols[i]));
            qb.push_bind(part.clone());
        }
        qb.push(")");
    }
    if first {
        qb.push("TRUE");
    }
    qb.push(")");
}

/// Touches: path [lga] or [lga, suburb] — match the deepest element against
/// the corresponding locality array. Checking an LGA matches every item
/// whose lgas[] carries it, which is the LGA-rolls-up-its-suburbs rule.
fn push_touches_clause(
    qb: &mut QueryBuilder<'_, Postgres>,
    lga_col: &str,
    suburb_col: &str,
    paths: &[Vec<String>],
) {
    qb.push(" AND (");
    let mut first = true;
    for path in paths {
        if !first {
            qb.push(" OR ");
        }
        first = false;
        if path.len() >= 2 {
            qb.push(format!("{suburb_col} @> ARRAY["));
            qb.push_bind(path[1].clone());
            qb.push("]::text[]");
        } else {
            qb.push(format!("{lga_col} @> ARRAY["));
            qb.push_bind(path[0].clone());
            qb.push("]::text[]");
        }
    }
    if first {
        qb.push("TRUE");
    }
    qb.push(")");
}

/// Bounds: floats only, so safe to interpolate (same rule as the ride list —
/// malformed bounds must mean "no items", not "all items").
fn push_bounds_clause(qb: &mut QueryBuilder<'_, Postgres>, geom: &str, bounds: &str) {
    let parts: Vec<f64> = bounds
        .split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .collect();
    if parts.len() == 4 {
        qb.push(format!(
            " AND ST_Intersects({geom}, ST_MakeEnvelope({}, {}, {}, {}, 4326))",
            parts[0], parts[1], parts[2], parts[3]
        ));
    } else {
        qb.push(" AND FALSE");
    }
}

/// One search pill over rides: every whitespace term must match one of the
/// searched fields (name, original names, description, localities, owner,
/// source, folder name). Requires the o/f/fo joins to be in scope.
fn push_ride_search(qb: &mut QueryBuilder<'_, Postgres>, query: &str) {
    for term in query.split_whitespace() {
        let pat = format!("%{term}%");
        qb.push(" AND (");
        let fields = [
            "r.name", "r.original_name", "r.description", "r.state", "r.region",
            "r.source", "o.name", "f.original_name", "fo.name",
            "array_to_string(r.lgas, ' ')", "array_to_string(r.suburbs, ' ')",
        ];
        for (i, field) in fields.iter().enumerate() {
            if i > 0 {
                qb.push(" OR ");
            }
            qb.push(format!("{field} ILIKE "));
            qb.push_bind(pat.clone());
        }
        qb.push(")");
    }
}

fn push_pack_search(qb: &mut QueryBuilder<'_, Postgres>, query: &str) {
    for term in query.split_whitespace() {
        let pat = format!("%{term}%");
        qb.push(" AND (p.name ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" OR p.description ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" OR fo.name ILIKE ");
        qb.push_bind(pat);
        qb.push(")");
    }
}

/// Append one pill's WHERE clause for the rides query (type is handled by
/// the caller via `type_selection`).
fn push_ride_filter(qb: &mut QueryBuilder<'_, Postgres>, f: &PillFilter) {
    match f.dimension.as_str() {
        "owner" => {
            let ids: Vec<Uuid> =
                str_values(f).iter().filter_map(|v| Uuid::parse_str(v).ok()).collect();
            if ids.is_empty() {
                // Same rule as folders: unparseable values match nothing.
                qb.push(" AND FALSE");
            } else {
                qb.push(" AND r.owner_id = ANY(");
                qb.push_bind(ids);
                qb.push("::uuid[])");
            }
        }
        "start_location" => push_location_clause(
            qb,
            ["r.state", "r.region", "r.lgas[1]", "r.suburbs[1]"],
            &path_values(f),
        ),
        "end_location" => push_location_clause(
            qb,
            ["r.end_state", "r.end_region", "r.end_lga", "r.end_suburb"],
            &path_values(f),
        ),
        "touches" => push_touches_clause(qb, "r.lgas", "r.suburbs", &path_values(f)),
        "folder" => push_folder_clause(qb, "r.folder_id", &str_values(f)),
        "has_hr" => {
            qb.push(" AND r.avg_hr IS NOT NULL");
        }
        "has_speed" => {
            qb.push(" AND r.avg_speed_kmh IS NOT NULL");
        }
        "is_loop" => {
            qb.push(format!(" AND {IS_LOOP}"));
        }
        _ => {}
    }
}

/// Append one pill's WHERE clause for the packs query; None = the pill
/// excludes packs outright (they lack the dimension).
fn push_pack_filter(qb: &mut QueryBuilder<'_, Postgres>, f: &PillFilter) -> Option<()> {
    match f.dimension.as_str() {
        "type" => Some(()), // handled by inclusion flags
        "owner" => None,    // packs have no owner
        "is_loop" => None,  // packs are not loops
        "start_location" => {
            push_location_clause(
                qb,
                ["p.state", "p.region", "p.lgas[1]", "p.suburbs[1]"],
                &path_values(f),
            );
            Some(())
        }
        "end_location" => {
            push_location_clause(
                qb,
                ["p.end_state", "p.end_region", "p.end_lga", "p.end_suburb"],
                &path_values(f),
            );
            Some(())
        }
        "touches" => {
            push_touches_clause(qb, "p.lgas", "p.suburbs", &path_values(f));
            Some(())
        }
        "folder" => {
            push_folder_clause(qb, "p.folder_id", &str_values(f));
            Some(())
        }
        "has_hr" => {
            qb.push(" AND p.has_hr");
            Some(())
        }
        "has_speed" => {
            qb.push(" AND p.has_speed");
            Some(())
        }
        _ => Some(()),
    }
}

/// Active pills: zero-checked pills are inactive (match everything) — that
/// covers boolean pills too, whose single checkable value is `true`. `skip`
/// names the facet dimension whose own pills must not narrow its dropdown.
fn active<'a>(q: &'a ItemsQuery, skip: Option<&'a str>) -> impl Iterator<Item = &'a PillFilter> {
    q.filters
        .iter()
        .filter(move |f| !f.values.is_empty() && Some(f.dimension.as_str()) != skip)
}

const RIDE_FROM: &str = " FROM rides r \
    JOIN owners o ON o.id = r.owner_id \
    JOIN files f ON f.id = r.file_id \
    LEFT JOIN folders fo ON fo.id = r.folder_id";

const PACK_FROM: &str = " FROM packs p \
    LEFT JOIN folders fo ON fo.id = p.folder_id";

/// Build the rides side of a query: `SELECT {select_body} FROM … {lateral}
/// WHERE …` with every active pill, search string and bounds applied.
/// Returns None when the type pill excludes both tracks and routes.
/// `lateral` lets facets append e.g. ", LATERAL unnest(r.lgas) t(v)".
fn ride_query<'a>(
    q: &'a ItemsQuery,
    select_body: &str,
    skip: Option<&'a str>,
    lateral: &str,
) -> Option<QueryBuilder<'a, Postgres>> {
    let (tracks, routes, _) = type_selection(&q.filters);
    let only_route = if skip == Some("type") {
        None
    } else {
        match (tracks, routes) {
            (true, true) => None,
            (true, false) => Some(false),
            (false, true) => Some(true),
            (false, false) => return None,
        }
    };
    let mut qb = QueryBuilder::new(format!(
        "SELECT {select_body}{RIDE_FROM}{lateral} \
         WHERE r.cleaned_geometry IS NOT NULL AND r.superseded_by IS NULL"
    ));
    if let Some(route) = only_route {
        qb.push(if route {
            format!(" AND {IS_ROUTE}")
        } else {
            format!(" AND NOT {IS_ROUTE}")
        });
    }
    for f in active(q, skip) {
        if f.dimension != "type" {
            push_ride_filter(&mut qb, f);
        }
    }
    for s in &q.search {
        push_ride_search(&mut qb, s);
    }
    if let Some(b) = &q.bounds {
        push_bounds_clause(&mut qb, "r.cleaned_geometry", b);
    }
    Some(qb)
}

/// Build the packs side; None when a pill (or the type pill) excludes packs.
/// Packs ignore `bounds` — they are recipes, not geometry, and hiding them
/// on pan would make the list feel broken.
fn pack_query<'a>(
    q: &'a ItemsQuery,
    select_body: &str,
    skip: Option<&'a str>,
    lateral: &str,
) -> Option<QueryBuilder<'a, Postgres>> {
    let (_, _, packs) = type_selection(&q.filters);
    if !packs && skip != Some("type") {
        return None;
    }
    let mut qb =
        QueryBuilder::new(format!("SELECT {select_body}{PACK_FROM}{lateral} WHERE TRUE"));
    for f in active(q, skip) {
        push_pack_filter(&mut qb, f)?;
    }
    for s in &q.search {
        push_pack_search(&mut qb, s);
    }
    Some(qb)
}

// ---- Item list ----

async fn items(pool: &PgPool, q: &ItemsQuery) -> Result<Json<serde_json::Value>, ApiError> {
    let limit = q.limit.unwrap_or(10000).clamp(0, 10000);

    let mut out: Vec<serde_json::Value> = Vec::new();

    if let Some(mut qb) = ride_query(
        q,
        &format!(
            "r.id, r.name, r.started_at, \
             ST_Length(r.cleaned_geometry::geography) AS distance_m, \
             EXTRACT(EPOCH FROM (r.ended_at - r.started_at))::float8 AS duration_s, \
             r.mode::text AS mode, r.grade, r.owner_id, o.name AS owner, \
             r.state, r.region, r.lgas, r.suburbs, \
             {IS_LOOP} AS is_loop, {IS_ROUTE} AS is_route, \
             r.kind::text AS kind, r.collection, r.color, r.folder_id, \
             r.avg_hr, r.max_hr, r.avg_speed_kmh AS avg_speed, r.max_speed_kmh AS max_speed, \
             (EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) \
              - COALESCE((SELECT SUM((s->>'duration_secs')::float8) \
                          FROM jsonb_array_elements(r.stops) s), 0))::float8 AS moving_s, \
             CASE WHEN r.kind = 'planned' THEN 'plan' \
                  WHEN r.origin = 'other' THEN 'other' \
                  WHEN r.track_type = 'route' OR r.started_at IS NULL THEN 'plan' \
                  ELSE 'own' END AS class"
        ),
        None,
        "",
    ) {
        qb.push(" ORDER BY r.started_at DESC NULLS LAST LIMIT ");
        qb.push_bind(limit);
        let rows = qb.build().fetch_all(pool).await.map_err(internal)?;
        for r in rows {
            out.push(serde_json::json!({
                "item_type": if r.get::<bool, _>("is_route") { "route" } else { "track" },
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<Option<String>, _>("name"),
                "started_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("started_at"),
                "distance_m": r.get::<Option<f64>, _>("distance_m"),
                "duration_s": r.get::<Option<f64>, _>("duration_s"),
                "moving_s": r.get::<Option<f64>, _>("moving_s"),
                "mode": r.get::<String, _>("mode"),
                "class": r.get::<String, _>("class"),
                "grade": r.get::<Option<i16>, _>("grade"),
                "owner_id": r.get::<Option<Uuid>, _>("owner_id"),
                "owner": r.get::<Option<String>, _>("owner"),
                "state": r.get::<Option<String>, _>("state"),
                "region": r.get::<Option<String>, _>("region"),
                "lgas": r.get::<Option<Vec<String>>, _>("lgas"),
                "suburbs": r.get::<Option<Vec<String>>, _>("suburbs"),
                "is_loop": r.get::<Option<bool>, _>("is_loop"),
                "kind": r.get::<String, _>("kind"),
                "collection": r.get::<Option<String>, _>("collection"),
                "color": r.get::<Option<String>, _>("color"),
                "folder_id": r.get::<Option<Uuid>, _>("folder_id"),
                "avg_hr": r.get::<Option<f64>, _>("avg_hr"),
                "max_hr": r.get::<Option<f64>, _>("max_hr"),
                "avg_speed": r.get::<Option<f64>, _>("avg_speed"),
                "max_speed": r.get::<Option<f64>, _>("max_speed"),
            }));
        }
    }

    if let Some(mut qb) = pack_query(
        q,
        "p.id, p.name, p.description, p.created_at, p.published_at, p.folder_id, \
         (SELECT count(*) FROM pack_rides pr WHERE pr.pack_id = p.id) AS ride_count",
        None,
        "",
    ) {
        qb.push(" ORDER BY p.created_at DESC LIMIT ");
        qb.push_bind(limit);
        let rows = qb.build().fetch_all(pool).await.map_err(internal)?;
        for r in rows {
            out.push(serde_json::json!({
                "item_type": "pack",
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "description": r.get::<String, _>("description"),
                "started_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "published_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("published_at"),
                "folder_id": r.get::<Option<Uuid>, _>("folder_id"),
                "ride_count": r.get::<i64, _>("ride_count"),
            }));
        }
    }

    Ok(Json(serde_json::json!({ "items": out })))
}

// ---- Facets ----

/// One dimension's value list with counts, narrowed by the OTHER pills.
async fn facet(
    pool: &PgPool,
    q: &ItemsQuery,
    dim: &str,
) -> Result<Json<serde_json::Value>, ApiError> {
    let values = match dim {
        "type" => facet_type(pool, q).await?,
        "owner" => facet_owner(pool, q).await?,
        "start_location" => {
            facet_location(pool, q, ["r.state", "r.region", "r.lgas[1]", "r.suburbs[1]"],
                ["p.state", "p.region", "p.lgas[1]", "p.suburbs[1]"], "start_location").await?
        }
        "end_location" => {
            facet_location(pool, q, ["r.end_state", "r.end_region", "r.end_lga", "r.end_suburb"],
                ["p.end_state", "p.end_region", "p.end_lga", "p.end_suburb"], "end_location").await?
        }
        "touches" => facet_touches(pool, q).await?,
        "folder" => facet_folder(pool, q).await?,
        "has_hr" | "has_speed" | "is_loop" => facet_boolean(pool, q, dim).await?,
        other => return Err(bad_request(format!("unknown facet dimension '{other}'"))),
    };
    Ok(Json(serde_json::json!({ "dimension": dim, "values": values })))
}

async fn facet_type(pool: &PgPool, q: &ItemsQuery) -> Result<Vec<serde_json::Value>, ApiError> {
    let mut track = 0i64;
    let mut route = 0i64;
    if let Some(mut qb) = ride_query(
        q,
        &format!("CASE WHEN {IS_ROUTE} THEN 'route' ELSE 'track' END AS v, count(*) AS n"),
        Some("type"),
        "",
    ) {
        qb.push(" GROUP BY 1");
        for r in qb.build().fetch_all(pool).await.map_err(internal)? {
            let v: String = r.get("v");
            let n: i64 = r.get("n");
            if v == "route" { route = n } else { track = n }
        }
    }
    let mut pack = 0i64;
    if let Some(mut qb) = pack_query(q, "count(*) AS n", Some("type"), "") {
        pack = qb
            .build()
            .fetch_one(pool)
            .await
            .map_err(internal)?
            .get::<i64, _>("n");
    }
    Ok(vec![
        serde_json::json!({ "value": "track", "label": "Tracks", "count": track }),
        serde_json::json!({ "value": "route", "label": "Routes", "count": route }),
        serde_json::json!({ "value": "pack", "label": "Packs", "count": pack }),
    ])
}

async fn facet_owner(pool: &PgPool, q: &ItemsQuery) -> Result<Vec<serde_json::Value>, ApiError> {
    let mut out = Vec::new();
    if let Some(mut qb) = ride_query(
        q,
        "r.owner_id::text AS v, o.name AS label, count(*) AS n",
        Some("owner"),
        "",
    ) {
        qb.push(" GROUP BY 1, 2 ORDER BY n DESC, label");
        for r in qb.build().fetch_all(pool).await.map_err(internal)? {
            out.push(serde_json::json!({
                "value": r.get::<String, _>("v"),
                "label": r.get::<String, _>("label"),
                "count": r.get::<i64, _>("n"),
            }));
        }
    }
    Ok(out)
}

/// Location facet: leaf rows (full 4-level path + count); the client folds
/// them into the expandable tree and sums counts per level.
async fn facet_location(
    pool: &PgPool,
    q: &ItemsQuery,
    ride_cols: [&str; 4],
    pack_cols: [&str; 4],
    dim: &str,
) -> Result<Vec<serde_json::Value>, ApiError> {
    let mut counts: HashMap<[String; 4], i64> = HashMap::new();
    let sel = |cols: [&str; 4]| {
        format!(
            "COALESCE({}, 'Unknown') AS l1, COALESCE({}, 'Unknown') AS l2, \
             COALESCE({}, 'Unknown') AS l3, COALESCE({}, 'Unknown') AS l4, count(*) AS n",
            cols[0], cols[1], cols[2], cols[3]
        )
    };
    let queries = [
        ride_query(q, &sel(ride_cols), Some(dim), ""),
        pack_query(q, &sel(pack_cols), Some(dim), ""),
    ];
    for qb in queries.into_iter().flatten() {
        let mut qb = qb;
        qb.push(" GROUP BY 1, 2, 3, 4");
        for r in qb.build().fetch_all(pool).await.map_err(internal)? {
            let key = [r.get("l1"), r.get("l2"), r.get("l3"), r.get("l4")];
            *counts.entry(key).or_default() += r.get::<i64, _>("n");
        }
    }
    let mut rows: Vec<_> = counts.into_iter().collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(rows
        .into_iter()
        .map(|(path, n)| serde_json::json!({ "path": path, "count": n }))
        .collect())
}

/// Touches facet: LGA rows (path [lga]) + suburb rows (path [lga, suburb],
/// grouped under an LGA via the gazetteer for display only — the filter
/// matches on the deepest path element).
async fn facet_touches(pool: &PgPool, q: &ItemsQuery) -> Result<Vec<serde_json::Value>, ApiError> {
    let mut lga_counts: HashMap<String, i64> = HashMap::new();
    let mut suburb_counts: HashMap<String, i64> = HashMap::new();

    // One row per item per array element; arrays are deduped at write time,
    // so count(*) per element counts items.
    let plans: [(Option<QueryBuilder<'_, Postgres>>, bool); 4] = [
        (ride_query(q, "t.v AS v, count(*) AS n", Some("touches"),
            ", LATERAL unnest(r.lgas) AS t(v)"), false),
        (ride_query(q, "t.v AS v, count(*) AS n", Some("touches"),
            ", LATERAL unnest(r.suburbs) AS t(v)"), true),
        (pack_query(q, "t.v AS v, count(*) AS n", Some("touches"),
            ", LATERAL unnest(p.lgas) AS t(v)"), false),
        (pack_query(q, "t.v AS v, count(*) AS n", Some("touches"),
            ", LATERAL unnest(p.suburbs) AS t(v)"), true),
    ];
    for (qb, is_suburb) in plans {
        let Some(mut qb) = qb else { continue };
        qb.push(" GROUP BY 1");
        let counts = if is_suburb { &mut suburb_counts } else { &mut lga_counts };
        for r in qb.build().fetch_all(pool).await.map_err(internal)? {
            let v: String = r.get("v");
            *counts.entry(v).or_default() += r.get::<i64, _>("n");
        }
    }

    // Suburb → LGA display grouping from the gazetteer (first match wins).
    let suburb_list: Vec<String> = suburb_counts.keys().cloned().collect();
    let mut suburb_lga: HashMap<String, String> = HashMap::new();
    if !suburb_list.is_empty() {
        let rows = sqlx::query(
            "SELECT DISTINCT ON (suburb) suburb, COALESCE(lga, 'Other') AS lga \
             FROM localities WHERE suburb = ANY($1) ORDER BY suburb, lga",
        )
        .bind(&suburb_list)
        .fetch_all(pool)
        .await
        .map_err(internal)?;
        for r in rows {
            suburb_lga.insert(r.get("suburb"), r.get("lga"));
        }
    }

    let mut out = Vec::new();
    let mut lgas: Vec<_> = lga_counts.into_iter().collect();
    lgas.sort_by(|a, b| a.0.cmp(&b.0));
    for (lga, n) in lgas {
        out.push(serde_json::json!({ "path": [lga], "count": n }));
    }
    let mut suburbs: Vec<_> = suburb_counts.into_iter().collect();
    suburbs.sort_by(|a, b| a.0.cmp(&b.0));
    for (suburb, n) in suburbs {
        let lga = suburb_lga.get(&suburb).cloned().unwrap_or_else(|| "Other".into());
        out.push(serde_json::json!({ "path": [lga, suburb], "count": n }));
    }
    Ok(out)
}

async fn facet_folder(pool: &PgPool, q: &ItemsQuery) -> Result<Vec<serde_json::Value>, ApiError> {
    let mut counts: HashMap<Option<Uuid>, i64> = HashMap::new();
    let queries = [
        ride_query(q, "r.folder_id AS v, count(*) AS n", Some("folder"), ""),
        pack_query(q, "p.folder_id AS v, count(*) AS n", Some("folder"), ""),
    ];
    for qb in queries.into_iter().flatten() {
        let mut qb = qb;
        qb.push(" GROUP BY 1");
        for r in qb.build().fetch_all(pool).await.map_err(internal)? {
            *counts.entry(r.get("v")).or_default() += r.get::<i64, _>("n");
        }
    }
    let mut out: Vec<_> = counts
        .into_iter()
        .map(|(id, n)| {
            (
                id.map(|u| u.to_string()).unwrap_or_else(|| "unfiled".into()),
                n,
            )
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out
        .into_iter()
        .map(|(value, n)| serde_json::json!({ "value": value, "count": n }))
        .collect())
}

async fn facet_boolean(
    pool: &PgPool,
    q: &ItemsQuery,
    dim: &str,
) -> Result<Vec<serde_json::Value>, ApiError> {
    let ride_expr = match dim {
        "has_hr" => "r.avg_hr IS NOT NULL",
        "has_speed" => "r.avg_speed_kmh IS NOT NULL",
        _ => IS_LOOP,
    };
    let mut n = 0i64;
    if let Some(mut qb) = ride_query(
        q,
        &format!("count(*) FILTER (WHERE {ride_expr}) AS n"),
        Some(dim),
        "",
    ) {
        n += qb.build().fetch_one(pool).await.map_err(internal)?.get::<i64, _>("n");
    }
    if dim != "is_loop" {
        let pack_expr = if dim == "has_hr" { "p.has_hr" } else { "p.has_speed" };
        if let Some(mut qb) = pack_query(
            q,
            &format!("count(*) FILTER (WHERE {pack_expr}) AS n"),
            Some(dim),
            "",
        ) {
            n += qb.build().fetch_one(pool).await.map_err(internal)?.get::<i64, _>("n");
        }
    }
    Ok(vec![serde_json::json!({ "value": true, "count": n })])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pill(dim: &str, values: serde_json::Value) -> PillFilter {
        PillFilter {
            dimension: dim.into(),
            values: values.as_array().cloned().unwrap_or_default(),
        }
    }

    fn query(filters: Vec<PillFilter>, search: Vec<&str>) -> ItemsQuery {
        ItemsQuery {
            filters,
            search: search.into_iter().map(str::to_owned).collect(),
            bounds: None,
            facet: None,
            limit: None,
        }
    }

    #[test]
    fn type_pill_splits_rides_and_packs() {
        // Only tracks: rides side gets NOT is_route, packs side is excluded.
        let q = query(vec![pill("type", serde_json::json!(["track"]))], vec![]);
        let rides = ride_query(&q, "r.id", None, "").expect("rides included");
        assert!(rides.sql().contains("AND NOT (r.kind = 'planned'"));
        assert!(pack_query(&q, "p.id", None, "").is_none());

        // Only packs: rides side vanishes entirely.
        let q = query(vec![pill("type", serde_json::json!(["pack"]))], vec![]);
        assert!(ride_query(&q, "r.id", None, "").is_none());
        assert!(pack_query(&q, "p.id", None, "").is_some());
    }

    #[test]
    fn zero_checked_pill_is_inactive() {
        let q = query(vec![pill("owner", serde_json::json!([]))], vec![]);
        let rides = ride_query(&q, "r.id", None, "").unwrap();
        assert!(!rides.sql().contains("owner_id = ANY"));
        assert!(!rides.sql().contains("AND FALSE"));
    }

    #[test]
    fn location_path_prefix_constrains_matching_levels() {
        let q = query(
            vec![pill(
                "start_location",
                serde_json::json!([["NSW"], ["NSW", "Snowy Mountains"]]),
            )],
            vec![],
        );
        let sql = ride_query(&q, "r.id", None, "").unwrap().sql().to_string();
        // One-level path binds only the state; two-level adds the region.
        assert_eq!(sql.matches("COALESCE(r.state, 'Unknown')").count(), 2);
        assert_eq!(sql.matches("COALESCE(r.region, 'Unknown')").count(), 1);
        assert!(!sql.contains("r.lgas[1]"));
    }

    #[test]
    fn touches_matches_deepest_level() {
        let q = query(
            vec![pill(
                "touches",
                serde_json::json!([["Snowy Valleys"], ["Snowy Valleys", "Talbingo"]]),
            )],
            vec![],
        );
        let sql = ride_query(&q, "r.id", None, "").unwrap().sql().to_string();
        assert!(sql.contains("r.lgas @> ARRAY["));
        assert!(sql.contains("r.suburbs @> ARRAY["));
    }

    #[test]
    fn owner_pill_excludes_packs() {
        let q = query(
            vec![pill(
                "owner",
                serde_json::json!(["b7f1a2ee-0000-0000-0000-000000000001"]),
            )],
            vec![],
        );
        assert!(pack_query(&q, "p.id", None, "").is_none());
        assert!(ride_query(&q, "r.id", None, "").unwrap().sql().contains("owner_id"));
    }

    #[test]
    fn facet_skips_own_dimension() {
        // An owner pill must not narrow the owner facet, but a folder pill must.
        let q = query(
            vec![
                pill("owner", serde_json::json!(["b7f1a2ee-0000-0000-0000-000000000001"])),
                pill("folder", serde_json::json!(["unfiled"])),
            ],
            vec![],
        );
        let sql = ride_query(&q, "r.id", Some("owner"), "").unwrap().sql().to_string();
        assert!(!sql.contains("owner_id = ANY"));
        assert!(sql.contains("r.folder_id IS NULL"));
    }

    #[test]
    fn malformed_bounds_match_nothing() {
        let q = ItemsQuery {
            filters: vec![],
            search: vec![],
            bounds: Some("151.0,NaN".into()),
            facet: None,
            limit: None,
        };
        let sql = ride_query(&q, "r.id", None, "").unwrap().sql().to_string();
        assert!(sql.contains("AND FALSE"));
    }

    #[test]
    fn search_reaches_folder_name_and_description() {
        let q = query(vec![], vec!["goat"]);
        let sql = ride_query(&q, "r.id", None, "").unwrap().sql().to_string();
        assert!(sql.contains("fo.name ILIKE"));
        assert!(sql.contains("r.description ILIKE"));
        let psql = pack_query(&q, "p.id", None, "").unwrap().sql().to_string();
        assert!(psql.contains("p.description ILIKE"));
    }

    #[test]
    fn folder_unfiled_and_subtree_combine() {
        let q = query(
            vec![pill(
                "folder",
                serde_json::json!(["unfiled", "b7f1a2ee-0000-0000-0000-000000000001"]),
            )],
            vec![],
        );
        let sql = ride_query(&q, "r.id", None, "").unwrap().sql().to_string();
        assert!(sql.contains("r.folder_id IS NULL OR r.folder_id IN (WITH RECURSIVE"));
    }
}
