//! Stop detection for GPS tracks
//!
//! Identifies periods where the rider has stopped (e.g., lunch break, photo stop)
//! vs slow technical sections.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::smooth::{GeoPoint, haversine_distance, wrap_lon};

/// Configuration for stop detection
#[derive(Debug, Clone)]
pub struct StopConfig {
    /// Minimum duration in seconds to be considered a stop
    pub min_duration_secs: i64,
    /// Maximum speed in m/s to be considered stopped
    pub max_speed_ms: f64,
    /// Maximum positional variance in meters during a stop
    pub max_variance_m: f64,
    /// Window size for variance calculation
    pub window_size: usize,
}

impl Default for StopConfig {
    fn default() -> Self {
        Self {
            min_duration_secs: 30,
            max_speed_ms: 0.5, // 0.5 m/s = 1.8 km/h
            max_variance_m: 10.0,
            window_size: 5,
        }
    }
}

/// A detected stop period in the track
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stop {
    /// Starting point index
    pub start_idx: usize,
    /// Ending point index (inclusive)
    pub end_idx: usize,
    /// Start time of the stop
    pub start_time: Option<DateTime<Utc>>,
    /// End time of the stop
    pub end_time: Option<DateTime<Utc>>,
    /// Duration in seconds
    pub duration_secs: i64,
    /// Average position during stop
    pub avg_lat: f64,
    pub avg_lon: f64,
}

/// Detect stops in a GPS track
///
/// A stop is defined as a period where:
/// - Speed is below threshold
/// - Positional variance is low (not just moving slowly on a technical section)
/// - Duration exceeds minimum threshold
pub fn detect_stops(points: &[GeoPoint], config: &StopConfig) -> Vec<Stop> {
    if points.len() < 3 {
        return vec![];
    }

    // Calculate speeds between consecutive points
    let speeds = calculate_speeds(points);

    // Find potential stop regions (consecutive slow points)
    let mut stops = Vec::new();
    let mut in_stop = false;
    let mut stop_start = 0;

    for (i, &speed) in speeds.iter().enumerate() {
        if speed <= config.max_speed_ms {
            if !in_stop {
                in_stop = true;
                // speeds[i] is the segment (i-1 -> i); a low value means the
                // rider was already at rest at point i-1, so the stop begins
                // there, not at i (which undercounted the stop by one sample).
                stop_start = i.saturating_sub(1);
            }
        } else if in_stop {
            // End of potential stop - the last slow point was i-1
            in_stop = false;
            if i > 0 {
                if let Some(stop) = validate_stop(points, stop_start, i - 1, config) {
                    stops.push(stop);
                }
            }
        }
    }

    // Check if we ended in a stop
    if in_stop {
        if let Some(stop) = validate_stop(points, stop_start, points.len() - 1, config) {
            stops.push(stop);
        }
    }

    stops
}

/// Calculate speed between consecutive points
fn calculate_speeds(points: &[GeoPoint]) -> Vec<f64> {
    let mut speeds = Vec::with_capacity(points.len());

    for i in 0..points.len() {
        if i == 0 {
            speeds.push(0.0);
            continue;
        }

        let dist = haversine_distance(
            points[i - 1].lat,
            points[i - 1].lon,
            points[i].lat,
            points[i].lon,
        );

        let time_diff = match (points[i - 1].time, points[i].time) {
            (Some(t1), Some(t2)) => (t2 - t1).num_milliseconds() as f64 / 1000.0,
            _ => 1.0, // Default to 1 second if no timestamps
        };

        let speed = if time_diff > 0.0 {
            dist / time_diff
        } else {
            0.0
        };
        speeds.push(speed.min(100.0)); // Cap at 100 m/s to avoid outliers
    }

    speeds
}

/// Validate a potential stop region
fn validate_stop(
    points: &[GeoPoint],
    start_idx: usize,
    end_idx: usize,
    config: &StopConfig,
) -> Option<Stop> {
    if end_idx <= start_idx {
        return None;
    }

    let stop_points = &points[start_idx..=end_idx.min(points.len() - 1)];

    // Check duration
    let duration = match (stop_points.first()?.time, stop_points.last()?.time) {
        (Some(t1), Some(t2)) => (t2 - t1).num_seconds(),
        _ => {
            // No timestamps - estimate based on point count
            stop_points.len() as i64 // Assume ~1 second per point
        }
    };

    if duration < config.min_duration_secs {
        return None;
    }

    // Calculate positional variance (spread around centroid). Longitudes are
    // averaged as offsets from the first point and re-wrapped so the centroid is
    // correct across the antimeridian.
    let n = stop_points.len() as f64;
    let lon_ref = stop_points[0].lon;
    let sum_lat: f64 = stop_points.iter().map(|p| p.lat).sum();
    let sum_lon_off: f64 = stop_points.iter().map(|p| wrap_lon(p.lon - lon_ref)).sum();
    let avg_lat = sum_lat / n;
    let avg_lon = wrap_lon(lon_ref + sum_lon_off / n);

    let max_dist_from_center = stop_points
        .iter()
        .map(|p| haversine_distance(p.lat, p.lon, avg_lat, avg_lon))
        .fold(0.0_f64, f64::max);

    // If variance is too high, this is slow movement, not a stop
    if max_dist_from_center > config.max_variance_m {
        return None;
    }

    Some(Stop {
        start_idx,
        end_idx: end_idx.min(points.len() - 1),
        start_time: stop_points.first().and_then(|p| p.time),
        end_time: stop_points.last().and_then(|p| p.time),
        duration_secs: duration,
        avg_lat,
        avg_lon,
    })
}

/// Calculate total stopped time from a list of stops
pub fn total_stopped_time(stops: &[Stop]) -> Duration {
    Duration::seconds(stops.iter().map(|s| s.duration_secs).sum())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_timed_point(lat: f64, lon: f64, secs_offset: i64) -> GeoPoint {
        GeoPoint {
            lat,
            lon,
            elevation: None,
            time: Some(Utc::now() + Duration::seconds(secs_offset)),
            heart_rate: None,
        }
    }

    #[test]
    fn test_detect_stop() {
        // Simple test: stationary for 60 seconds at exact same location
        let mut points = Vec::new();

        // Stopped phase - exact same coordinates, 60 seconds
        for i in 0..60 {
            points.push(make_timed_point(-27.4698, 153.0251, i));
        }

        // Start moving (very fast to be clearly above threshold)
        for i in 60..65 {
            let offset = (i - 60 + 1) as f64; // +1 so first point has movement
            points.push(make_timed_point(
                -27.4698 - (offset * 0.01), // ~1km per point
                153.0251,
                i,
            ));
        }

        let config = StopConfig {
            min_duration_secs: 30,
            max_speed_ms: 1.0, // 1 m/s threshold
            max_variance_m: 50.0,
            window_size: 5,
        };
        let stops = detect_stops(&points, &config);

        // Debug: should have detected stopped phase
        assert!(!stops.is_empty(), "Should detect stationary period of 60s");
        assert!(stops[0].duration_secs >= 30, "Stop should be at least 30s");
    }

    #[test]
    fn test_slow_movement_not_stop() {
        // Slow but continuous movement should NOT be a stop
        let mut points = Vec::new();

        for i in 0..60 {
            // Moving ~1m per second in a consistent direction
            points.push(make_timed_point(
                -27.4698 - (i as f64 * 0.00001),
                153.0251 + (i as f64 * 0.00001),
                i,
            ));
        }

        let config = StopConfig {
            max_variance_m: 5.0, // Tight variance requirement
            ..Default::default()
        };
        let stops = detect_stops(&points, &config);

        // Should not detect this as a stop due to positional variance
        assert!(stops.is_empty());
    }
}
