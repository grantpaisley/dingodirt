//! Internal track representation
//!
//! This is the common format that all parsers convert to,
//! regardless of source format (GPX, FIT, etc.)

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A single point in a track
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackPoint {
    /// Latitude in degrees (-90 to 90)
    pub lat: f64,
    /// Longitude in degrees (-180 to 180)
    pub lon: f64,
    /// Elevation in meters (optional)
    pub elevation: Option<f64>,
    /// Timestamp (optional - present for rides, absent for routes)
    pub time: Option<DateTime<Utc>>,
    /// Speed in m/s (optional, from GPS or enhanced_speed)
    pub speed: Option<f32>,
    /// Heart rate in BPM (optional, from sensor)
    pub heart_rate: Option<u8>,
    /// Cadence in RPM (optional, from sensor)
    pub cadence: Option<u8>,
    /// Power in watts (optional, from sensor)
    pub power: Option<u16>,
    /// Temperature in Celsius (optional, from sensor)
    pub temperature: Option<i8>,
}

impl TrackPoint {
    /// Create a new track point with just coordinates
    pub fn new(lat: f64, lon: f64) -> Self {
        Self {
            lat,
            lon,
            elevation: None,
            time: None,
            speed: None,
            heart_rate: None,
            cadence: None,
            power: None,
            temperature: None,
        }
    }

    /// Create a point with elevation
    pub fn with_elevation(lat: f64, lon: f64, elevation: f64) -> Self {
        Self {
            elevation: Some(elevation),
            ..Self::new(lat, lon)
        }
    }
}

/// Whether this track represents a ride (with timestamps) or a route (geometry only)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrackType {
    /// Ride: has timestamps, represents actual recorded activity
    Ride,
    /// Route: geometry only, no timestamps (e.g., planned route, imported trail)
    Route,
}

/// Whose track this is: the user's own recording or someone else's file
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RideOrigin {
    /// Recorded by the user (default)
    Own,
    /// Imported from someone else
    Other,
}

impl RideOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            RideOrigin::Own => "self",
            RideOrigin::Other => "other",
        }
    }
}

/// A parsed track from any source format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    /// Track name (from file metadata or generated)
    pub name: Option<String>,
    /// Track description
    pub description: Option<String>,
    /// Display color (`#rrggbb`) from GPX extensions, if the file carried one
    pub color: Option<String>,
    /// Whether this is a ride or route
    pub track_type: TrackType,
    /// The track points
    pub points: Vec<TrackPoint>,
    /// Start time of the track (if ride)
    pub started_at: Option<DateTime<Utc>>,
    /// End time of the track (if ride)
    pub ended_at: Option<DateTime<Utc>>,
    /// Source format
    pub source_format: String,
    /// FIT sport type (e.g., "cycling", "running")
    pub fit_sport: Option<String>,
    /// FIT sub-sport type (e.g., "mountain", "road")
    pub fit_sub_sport: Option<String>,
    /// Device manufacturer (from FIT FileId)
    pub device_manufacturer: Option<String>,
    /// Device product name
    pub device_product: Option<String>,
}

impl Track {
    /// Create a new empty track
    pub fn new(name: Option<String>, track_type: TrackType) -> Self {
        Self {
            name,
            description: None,
            color: None,
            track_type,
            points: Vec::new(),
            started_at: None,
            ended_at: None,
            source_format: String::new(),
            fit_sport: None,
            fit_sub_sport: None,
            device_manufacturer: None,
            device_product: None,
        }
    }

    /// Determine track type based on whether points have timestamps
    pub fn infer_type(&self) -> TrackType {
        // If any point has a timestamp, it's a ride
        if self.points.iter().any(|p| p.time.is_some()) {
            TrackType::Ride
        } else {
            TrackType::Route
        }
    }

    /// Update started_at and ended_at from points
    pub fn update_time_bounds(&mut self) {
        self.started_at = self.points.iter().filter_map(|p| p.time).min();
        self.ended_at = self.points.iter().filter_map(|p| p.time).max();
    }

    /// Get the number of points in this track
    pub fn len(&self) -> usize {
        self.points.len()
    }

    /// Check if the track has no points
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Check if track has sensor data (HR, cadence, power)
    pub fn has_sensor_data(&self) -> bool {
        self.points
            .iter()
            .any(|p| p.heart_rate.is_some() || p.cadence.is_some() || p.power.is_some())
    }

    /// Get duration in seconds (if ride with timestamps)
    pub fn duration_seconds(&self) -> Option<i64> {
        match (self.started_at, self.ended_at) {
            (Some(start), Some(end)) => Some((end - start).num_seconds()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_track_type_inference() {
        let mut track = Track::new(Some("Test".to_string()), TrackType::Route);

        // No timestamps = Route
        track.points.push(TrackPoint::new(-27.5, 153.0));
        assert_eq!(track.infer_type(), TrackType::Route);

        // Add timestamp = Ride
        track.points[0].time = Some(Utc::now());
        assert_eq!(track.infer_type(), TrackType::Ride);
    }

    #[test]
    fn test_time_bounds() {
        let mut track = Track::new(None, TrackType::Ride);

        let now = Utc::now();
        let later = now + chrono::Duration::hours(1);

        track.points.push(TrackPoint {
            time: Some(now),
            ..TrackPoint::new(-27.5, 153.0)
        });
        track.points.push(TrackPoint {
            time: Some(later),
            ..TrackPoint::new(-27.6, 153.1)
        });

        track.update_time_bounds();

        assert_eq!(track.started_at, Some(now));
        assert_eq!(track.ended_at, Some(later));
        assert_eq!(track.duration_seconds(), Some(3600));
    }
}
