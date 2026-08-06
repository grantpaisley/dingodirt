//! Heat harvester — slowly mirrors raster heat tiles (Strava's global heatmap,
//! later baked GPX heat) into local MBTiles archives, driven by a resumable
//! PostGIS frontier queue with pruning descent.
//!
//! Design: Docs/plans/2026-07-12-heat-harvester-design.md (+ the owners
//! refinement in 2026-07-12-owners-and-import-design.md — sources *are* owners).

pub mod fetch;
pub mod frontier;
pub mod heat;
pub mod limiter;
pub mod mbtiles;
pub mod tiles;
pub mod worker;
