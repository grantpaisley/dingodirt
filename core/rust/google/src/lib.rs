//! Dingo Google — Google Photos acquisition
//!
//! Phase 2: Takeout archive import (bulk backfill with geo + link-out URLs).
//! Later: Picker API for incremental imports (OAuth; no geo, no link-out —
//! see Docs/dingo-architecture-design.md, Photo Enrichment Pipeline).

pub mod maps;
pub mod photo_match;
pub mod takeout;

pub use maps::{DirRequest, build_route_gpx, compute_route, parse_dir_url, resolve_url};
pub use photo_match::{PhotoMatchSummary, match_photos};
pub use takeout::{ImportSummary, import_takeout};
