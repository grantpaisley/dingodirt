//! Dingo Enrich - context enrichment: weather fetch, solar position

pub mod condition;
pub mod dem;
pub mod elevation;
pub mod gazetteer;
pub mod ride_naming;
pub mod roads;
pub mod service;
pub mod solar;
pub mod weather;

pub use condition::{ConditionInference, ConfidenceLevel, TrailCondition};
pub use gazetteer::{
    Locality, RegionMap, load_gazetteer, load_region_map, load_regions, locality_count,
    nearest_locality,
};
pub use ride_naming::{
    NamingSummary, backfill_regions, is_closed_loop, is_junk_name, locate_planned_rides,
    name_all_rides, name_unlocated_rides,
};
pub use elevation::{ElevationSummary, backfill_elevation, backfill_elevation_for};
pub use roads::{load_roads, roads_count};
pub use service::{EnrichResult, EnrichSummary, enrich_all_rides, enrich_ride};
pub use solar::TimeOfDay;
pub use weather::{DailyWeather, OpenMeteoClient};
