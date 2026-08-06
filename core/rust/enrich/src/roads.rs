//! Offline roads table — named OSM ways for turn-cue generation.
//!
//! Loaded from a Geofabrik `.osm.pbf` extract via `dingo gazetteer
//! load-roads`. Only *named* drivable/rideable ways are kept (name tag, or
//! ref as a fallback for numbered routes); unnamed bush singletrack never
//! enters the table, which is what keeps turn cues quiet off-road.
//! Replace-all load, same convention as the locality gazetteer.
//!
//! Memory note: the loader holds the node ids of every kept way, then their
//! coordinates — several hundred MB for the full Australia extract. Fine on
//! a dev machine; not something the daemon ever does.

use osmpbf::{Element, ElementReader};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tracing::info;

use dingo_core::{Error, Result};

/// Highway classes worth cueing on. Footways/paths/cycleways are excluded:
/// v1 turn cues are for roads and named vehicle tracks (fire trails).
const HIGHWAY_CLASSES: &[&str] = &[
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
    "track",
];

struct KeptWay {
    name: String,
    class: String,
    node_refs: Vec<i64>,
}

/// Load named roads from an OSM PBF extract. Returns the number of ways
/// inserted. Replace-all: the existing roads table is cleared first.
pub async fn load_roads(pool: &PgPool, path: &Path) -> Result<usize> {
    let (ways, coords) = parse_pbf(path)?;
    info!(
        ways = ways.len(),
        nodes = coords.len(),
        "PBF parsed, loading roads table"
    );

    let mut tx = pool.begin().await?;
    sqlx::query!("DELETE FROM roads").execute(&mut *tx).await?;

    let mut loaded = 0usize;
    let mut batch: Vec<(String, String, String)> = Vec::with_capacity(5000);
    for way in &ways {
        let Some(wkt) = way_wkt(way, &coords) else {
            continue;
        };
        batch.push((way.name.clone(), way.class.clone(), wkt));
        if batch.len() >= 5000 {
            loaded += insert_batch(&mut tx, &batch).await?;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        loaded += insert_batch(&mut tx, &batch).await?;
    }
    tx.commit().await?;

    info!(loaded, "Roads load complete");
    Ok(loaded)
}

/// Two sequential scans: ways first (collect kept ways + the node ids they
/// need), then nodes (coordinates for exactly those ids).
fn parse_pbf(path: &Path) -> Result<(Vec<KeptWay>, HashMap<i64, (f64, f64)>)> {
    let mut ways: Vec<KeptWay> = Vec::new();
    let mut needed: HashSet<i64> = HashSet::new();

    let reader = ElementReader::from_path(path)
        .map_err(|e| Error::InvalidInput(format!("Cannot open PBF {path:?}: {e}")))?;
    reader
        .for_each(|element| {
            if let Element::Way(way) = element {
                let mut name: Option<String> = None;
                let mut reference: Option<String> = None;
                let mut class: Option<String> = None;
                for (k, v) in way.tags() {
                    match k {
                        "name" => name = Some(v.to_string()),
                        "ref" => reference = Some(v.to_string()),
                        "highway" if HIGHWAY_CLASSES.contains(&v) => class = Some(v.to_string()),
                        _ => {}
                    }
                }
                let (Some(class), Some(name)) = (class, name.or(reference)) else {
                    return;
                };
                let node_refs: Vec<i64> = way.refs().collect();
                if node_refs.len() < 2 {
                    return;
                }
                needed.extend(&node_refs);
                ways.push(KeptWay {
                    name,
                    class,
                    node_refs,
                });
            }
        })
        .map_err(|e| Error::InvalidInput(format!("PBF way scan failed: {e}")))?;

    let mut coords: HashMap<i64, (f64, f64)> = HashMap::with_capacity(needed.len());
    let reader = ElementReader::from_path(path)
        .map_err(|e| Error::InvalidInput(format!("Cannot open PBF {path:?}: {e}")))?;
    reader
        .for_each(|element| match element {
            Element::Node(node) => {
                if needed.contains(&node.id()) {
                    coords.insert(node.id(), (node.lon(), node.lat()));
                }
            }
            Element::DenseNode(node) => {
                if needed.contains(&node.id()) {
                    coords.insert(node.id(), (node.lon(), node.lat()));
                }
            }
            _ => {}
        })
        .map_err(|e| Error::InvalidInput(format!("PBF node scan failed: {e}")))?;

    Ok((ways, coords))
}

/// WKT LINESTRING for a way; None when node coords are missing (way crosses
/// the extract boundary) or fewer than 2 points survive.
fn way_wkt(way: &KeptWay, coords: &HashMap<i64, (f64, f64)>) -> Option<String> {
    let pts: Vec<(f64, f64)> = way
        .node_refs
        .iter()
        .filter_map(|id| coords.get(id).copied())
        .collect();
    if pts.len() < 2 {
        return None;
    }
    let body = pts
        .iter()
        .map(|(lon, lat)| format!("{lon} {lat}"))
        .collect::<Vec<_>>()
        .join(",");
    Some(format!("LINESTRING({body})"))
}

async fn insert_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    batch: &[(String, String, String)],
) -> Result<usize> {
    let names: Vec<&str> = batch.iter().map(|b| b.0.as_str()).collect();
    let classes: Vec<&str> = batch.iter().map(|b| b.1.as_str()).collect();
    let wkts: Vec<&str> = batch.iter().map(|b| b.2.as_str()).collect();

    let result = sqlx::query(
        r#"
        INSERT INTO roads (name, highway_class, geom)
        SELECT n, c, ST_GeomFromText(w, 4326)
        FROM unnest($1::text[], $2::text[], $3::text[]) AS t(n, c, w)
        "#,
    )
    .bind(&names)
    .bind(&classes)
    .bind(&wkts)
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected() as usize)
}

/// Row count, for `dingo gazetteer status`.
pub async fn roads_count(pool: &PgPool) -> Result<i64> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM roads")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
