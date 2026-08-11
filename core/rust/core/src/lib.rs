//! Dingo Core - shared domain types, configuration, and database utilities

pub mod area;
pub mod area_service;
pub mod config;
pub mod db;
pub mod error;
pub mod ids;
pub mod poi;
pub mod track_name;

pub use config::Config;
pub use error::{Error, Result};
pub use ids::*;
pub use track_name::is_junk_name;
