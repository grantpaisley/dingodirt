//! Dingo Ingest - file parsing and content-addressed storage
//!
//! This crate handles:
//! - Content-addressed file storage (files/{sha256}.{ext})
//! - Format detection (FIT, GPX, KML, GeoJSON, TCX)
//! - Parsing GPX and FIT files into internal track representation
//! - Database insertion of files and rides
//! - Zip file handling (Garmin GDPR exports)

pub mod dry_run;
pub mod file_store;
pub mod fit;
pub mod format;
pub mod gpx;
pub mod html;
pub mod palette;
pub mod repository;
pub mod routes_import;
pub mod service;
pub mod track;
pub mod zip;

pub use dry_run::{DryRunReport, dry_run_scan};
pub use file_store::FileStore;
pub use format::{FileFormat, detect_format};
pub use gpx::{GpxWaypoint, ParsedGpx, parse_gpx_file};
pub use routes_import::{RoutesImportResult, import_routes};
pub use service::{IngestResult, IngestSummary, ingest_directory, ingest_file};
pub use track::{RideOrigin, Track, TrackPoint, TrackType};
pub use zip::{ingest_zip, ingest_zip_limited};
