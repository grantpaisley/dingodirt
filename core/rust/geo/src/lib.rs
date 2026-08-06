//! Dingo Geo - geometry operations: cleaning, snapping, simplification

pub mod classify;
pub mod cleaning;
pub mod service;
pub mod simplify;
pub mod smooth;
pub mod stops;
pub mod turns;

pub use classify::{RideStats, classify_mode};
pub use cleaning::{CleanedTrack, CleaningConfig, TrackCleaner};
pub use service::{
    CleanResult, CleanSummary, ReclassifySummary, clean_all_rides, clean_ride,
    reclassify_all_modes,
};
