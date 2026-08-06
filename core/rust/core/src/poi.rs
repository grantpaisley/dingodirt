//! Point-of-interest domain types
//!
//! POIs come from curated route files (GPX `<wpt>` elements with Garmin
//! symbol names) and, later, from user-authored planned rides. The category
//! enum is deliberately small — planning cares about fuel, camping, and
//! water above all — and the original symbol string is preserved alongside
//! the mapped category so unmapped symbols can be re-mapped losslessly.

use serde::{Deserialize, Serialize};

/// POI category, mirrored by the `poi_category` Postgres enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "poi_category", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PoiCategory {
    Fuel,
    Camp,
    Water,
    Food,
    Lodging,
    Scenic,
    Hazard,
    Medical,
    Info,
    Summit,
    /// Fallback for symbols with no better mapping
    Poi,
}

impl PoiCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            PoiCategory::Fuel => "fuel",
            PoiCategory::Camp => "camp",
            PoiCategory::Water => "water",
            PoiCategory::Food => "food",
            PoiCategory::Lodging => "lodging",
            PoiCategory::Scenic => "scenic",
            PoiCategory::Hazard => "hazard",
            PoiCategory::Medical => "medical",
            PoiCategory::Info => "info",
            PoiCategory::Summit => "summit",
            PoiCategory::Poi => "poi",
        }
    }

    /// Parse the database enum string ("fuel", "camp", …) back to a category.
    pub fn from_db_str(s: &str) -> Option<PoiCategory> {
        Some(match s {
            "fuel" => PoiCategory::Fuel,
            "camp" => PoiCategory::Camp,
            "water" => PoiCategory::Water,
            "food" => PoiCategory::Food,
            "lodging" => PoiCategory::Lodging,
            "scenic" => PoiCategory::Scenic,
            "hazard" => PoiCategory::Hazard,
            "medical" => PoiCategory::Medical,
            "info" => PoiCategory::Info,
            "summit" => PoiCategory::Summit,
            "poi" => PoiCategory::Poi,
            _ => return None,
        })
    }

    /// Map a Garmin `<sym>` name to a category. Matching is case-insensitive.
    /// Unknown symbols (and None) fall back to `Poi`; callers keep the raw
    /// symbol string so the mapping can evolve without data loss.
    pub fn from_garmin_sym(sym: Option<&str>) -> PoiCategory {
        let Some(sym) = sym else {
            return PoiCategory::Poi;
        };
        match sym.trim().to_ascii_lowercase().as_str() {
            "gas station" => PoiCategory::Fuel,
            "campground" | "rv park" => PoiCategory::Camp,
            "drinking water" | "swimming area" | "shower" | "water source" => PoiCategory::Water,
            "bar" | "restaurant" | "winery" | "convenience store" | "shopping center" => {
                PoiCategory::Food
            }
            "lodging" | "lodge" | "hotel" | "bed and breakfast" => PoiCategory::Lodging,
            "scenic area" | "museum" | "park" | "ghost town" | "beach" | "mine" | "tall tower"
            | "church" | "dam" | "waterfall" => PoiCategory::Scenic,
            "skull and crossbones" | "circle with x" | "triangle, red" | "flag, red"
            | "square, red" | "crossing" | "danger area" => PoiCategory::Hazard,
            "medical facility" | "hospital" | "first aid" => PoiCategory::Medical,
            "information" | "toll booth" | "contact, ranger" | "contact, biker"
            | "trail head" => PoiCategory::Info,
            "summit" => PoiCategory::Summit,
            _ => PoiCategory::Poi,
        }
    }

    /// Garmin `<sym>` name for GPX export — the inverse of `from_garmin_sym`,
    /// collapsed to one representative symbol per category so OsmAnd/Locus
    /// render a sensible icon.
    pub fn garmin_sym(&self) -> &'static str {
        match self {
            PoiCategory::Fuel => "Gas Station",
            PoiCategory::Camp => "Campground",
            PoiCategory::Water => "Drinking Water",
            PoiCategory::Food => "Restaurant",
            PoiCategory::Lodging => "Lodging",
            PoiCategory::Scenic => "Scenic Area",
            PoiCategory::Hazard => "Skull and Crossbones",
            PoiCategory::Medical => "Medical Facility",
            PoiCategory::Info => "Information",
            PoiCategory::Summit => "Summit",
            PoiCategory::Poi => "Waypoint",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_planning_critical_syms() {
        assert_eq!(
            PoiCategory::from_garmin_sym(Some("Gas Station")),
            PoiCategory::Fuel
        );
        assert_eq!(
            PoiCategory::from_garmin_sym(Some("Campground")),
            PoiCategory::Camp
        );
        assert_eq!(
            PoiCategory::from_garmin_sym(Some("RV Park")),
            PoiCategory::Camp
        );
        assert_eq!(
            PoiCategory::from_garmin_sym(Some("Skull and Crossbones")),
            PoiCategory::Hazard
        );
        assert_eq!(
            PoiCategory::from_garmin_sym(Some("Medical Facility")),
            PoiCategory::Medical
        );
    }

    #[test]
    fn is_case_insensitive_and_trims() {
        assert_eq!(
            PoiCategory::from_garmin_sym(Some("  gas station ")),
            PoiCategory::Fuel
        );
        assert_eq!(
            PoiCategory::from_garmin_sym(Some("BAR")),
            PoiCategory::Food
        );
    }

    #[test]
    fn unknown_and_missing_fall_back_to_poi() {
        assert_eq!(PoiCategory::from_garmin_sym(Some("Covey")), PoiCategory::Poi);
        assert_eq!(PoiCategory::from_garmin_sym(None), PoiCategory::Poi);
    }

    #[test]
    fn garmin_sym_round_trips_through_category() {
        for cat in [
            PoiCategory::Fuel,
            PoiCategory::Camp,
            PoiCategory::Water,
            PoiCategory::Food,
            PoiCategory::Lodging,
            PoiCategory::Scenic,
            PoiCategory::Hazard,
            PoiCategory::Medical,
            PoiCategory::Info,
            PoiCategory::Summit,
        ] {
            assert_eq!(PoiCategory::from_garmin_sym(Some(cat.garmin_sym())), cat);
        }
    }
}
