//! Strongly-typed ID newtypes for domain entities

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! define_id {
    ($name:ident, $doc:expr) => {
        #[doc = $doc]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
        #[sqlx(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            pub fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }

            /// Parse from a string (UUID format)
            pub fn parse(s: &str) -> Result<Self, uuid::Error> {
                Ok(Self(Uuid::parse_str(s)?))
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl From<Uuid> for $name {
            fn from(uuid: Uuid) -> Self {
                Self(uuid)
            }
        }
    };
}

define_id!(AreaId, "Unique identifier for a riding area");
define_id!(OwnerId, "Unique identifier for an owner (person or data source)");
define_id!(FileId, "Unique identifier for an ingested file");
define_id!(RideId, "Unique identifier for a ride");
define_id!(RouteId, "Unique identifier for a route (geometry-only)");
define_id!(PoiId, "Unique identifier for a point of interest");
define_id!(PhotoId, "Unique identifier for a photo");
define_id!(SavedRouteId, "Unique identifier for a saved route");
