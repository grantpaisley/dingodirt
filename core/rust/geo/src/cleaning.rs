//! Track cleaning orchestration
//!
//! Combines GPS smoothing, simplification, and stop detection into a
//! unified cleaning pipeline.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::simplify::{SimplifyConfig, simplify_track};
use crate::smooth::{GeoPoint, SmoothConfig, smooth_track};
use crate::stops::{Stop, StopConfig, detect_stops};

/// Configuration for the full track cleaning pipeline
#[derive(Debug, Clone, Default)]
pub struct CleaningConfig {
    pub smooth: SmoothConfig,
    pub simplify: SimplifyConfig,
    pub stops: StopConfig,
}

/// Result of cleaning a track
#[derive(Debug, Clone)]
pub struct CleanedTrack {
    /// Cleaned and smoothed points (before simplification)
    pub smoothed_points: Vec<GeoPoint>,
    /// Simplified point indices (into smoothed_points)
    pub simplified_indices: Vec<usize>,
    /// Detected stops
    pub stops: Vec<Stop>,
    /// Stats about the cleaning process
    pub stats: CleaningStats,
}

impl CleanedTrack {
    /// Get the simplified points (common use case)
    pub fn simplified_points(&self) -> Vec<GeoPoint> {
        self.simplified_indices
            .iter()
            .map(|&i| self.smoothed_points[i].clone())
            .collect()
    }

    /// Get total stopped time in seconds
    pub fn total_stopped_secs(&self) -> i64 {
        self.stops.iter().map(|s| s.duration_secs).sum()
    }

    /// Cleaned time series for storage.
    ///
    /// Speed, cumulative distance and the `is_stopped` flag are computed on the
    /// full-resolution smoothed track — the space in which `Stop::start_idx`/
    /// `end_idx` are valid — and only then reduced to the simplified points.
    /// Extracting directly from the simplified points (the previous behaviour)
    /// tested smoothed-array stop indices against the shorter simplified array,
    /// so stops marked the wrong points or none at all, corrupting `is_stopped`
    /// and the speed-based mode classification that depends on it.
    pub fn time_series(&self) -> Vec<CleanedTimeSeriesPoint> {
        let full = extract_time_series(&self.smoothed_points, &self.stops);
        self.simplified_indices
            .iter()
            .map(|&i| full[i].clone())
            .collect()
    }
}

/// Statistics about the cleaning process
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleaningStats {
    /// Original point count
    pub original_points: usize,
    /// Points after smoothing (same as original)
    pub smoothed_points: usize,
    /// Points after simplification
    pub simplified_points: usize,
    /// Reduction percentage
    pub reduction_percent: f64,
    /// Number of stops detected
    pub stops_detected: usize,
    /// Total stopped time in seconds
    pub total_stopped_secs: i64,
}

/// Track cleaner that applies the full cleaning pipeline
pub struct TrackCleaner {
    config: CleaningConfig,
}

impl TrackCleaner {
    pub fn new(config: CleaningConfig) -> Self {
        Self { config }
    }

    pub fn with_defaults() -> Self {
        Self::new(CleaningConfig::default())
    }

    /// Clean a track represented as a list of points
    pub fn clean(&self, points: &[GeoPoint]) -> CleanedTrack {
        if points.is_empty() {
            return CleanedTrack {
                smoothed_points: vec![],
                simplified_indices: vec![],
                stops: vec![],
                stats: CleaningStats {
                    original_points: 0,
                    smoothed_points: 0,
                    simplified_points: 0,
                    reduction_percent: 0.0,
                    stops_detected: 0,
                    total_stopped_secs: 0,
                },
            };
        }

        // Step 1: Smooth GPS jitter
        let smoothed = smooth_track(points, &self.config.smooth);

        // Step 2: Detect stops (on smoothed data)
        let stops = detect_stops(&smoothed, &self.config.stops);

        // Step 3: Simplify track (reduce points while preserving shape)
        let simplified_indices = simplify_track(&smoothed, &self.config.simplify);

        let original_count = points.len();
        let simplified_count = simplified_indices.len();
        let reduction = if original_count > 0 {
            100.0 * (1.0 - (simplified_count as f64 / original_count as f64))
        } else {
            0.0
        };

        let stops_detected = stops.len();
        let total_stopped: i64 = stops.iter().map(|s| s.duration_secs).sum();

        CleanedTrack {
            smoothed_points: smoothed,
            simplified_indices,
            stops,
            stats: CleaningStats {
                original_points: original_count,
                smoothed_points: original_count, // Smoothing doesn't change count
                simplified_points: simplified_count,
                reduction_percent: reduction,
                stops_detected,
                total_stopped_secs: total_stopped,
            },
        }
    }
}

/// Cleaned time series point for storage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanedTimeSeriesPoint {
    pub time: Option<DateTime<Utc>>,
    pub lat: f64,
    pub lon: f64,
    pub ele: Option<f64>,
    /// Speed in m/s (calculated from previous point)
    pub speed_ms: Option<f64>,
    /// Cumulative distance in meters
    pub distance_cumulative_m: f64,
    /// Whether this point is during a stop
    pub is_stopped: bool,
    /// Heart rate in bpm (optional)
    pub heart_rate: Option<u8>,
}

/// Extract cleaned time series from track points
pub fn extract_time_series(points: &[GeoPoint], stops: &[Stop]) -> Vec<CleanedTimeSeriesPoint> {
    use crate::smooth::haversine_distance;

    let mut result = Vec::with_capacity(points.len());
    let mut cumulative_distance = 0.0;

    for (i, point) in points.iter().enumerate() {
        // Calculate speed and distance from previous point
        let (speed, dist) = if i > 0 {
            let prev = &points[i - 1];
            let d = haversine_distance(prev.lat, prev.lon, point.lat, point.lon);

            let s = match (prev.time, point.time) {
                (Some(t1), Some(t2)) => {
                    let dt = (t2 - t1).num_milliseconds() as f64 / 1000.0;
                    if dt > 0.0 { Some(d / dt) } else { None }
                }
                _ => None,
            };

            (s, d)
        } else {
            (Some(0.0), 0.0)
        };

        cumulative_distance += dist;

        // Check if this point is during a stop
        let is_stopped = stops.iter().any(|s| i >= s.start_idx && i <= s.end_idx);

        result.push(CleanedTimeSeriesPoint {
            time: point.time,
            lat: point.lat,
            lon: point.lon,
            ele: point.elevation,
            speed_ms: speed,
            distance_cumulative_m: cumulative_distance,
            is_stopped,
            heart_rate: point.heart_rate,
        });
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn make_track(n: usize) -> Vec<GeoPoint> {
        (0..n)
            .map(|i| GeoPoint {
                lat: -27.4698 - (i as f64 * 0.0001),
                lon: 153.0251 + (i as f64 * 0.0001),
                elevation: Some(10.0 + i as f64),
                time: Some(Utc::now() + Duration::seconds(i as i64)),
                heart_rate: None,
            })
            .collect()
    }

    #[test]
    fn test_cleaning_pipeline() {
        let points = make_track(100);
        let cleaner = TrackCleaner::with_defaults();
        let result = cleaner.clean(&points);

        // Should have fewer simplified points than original
        assert!(result.stats.simplified_points < result.stats.original_points);
        assert!(result.stats.reduction_percent > 0.0);
    }

    #[test]
    fn test_empty_track() {
        let cleaner = TrackCleaner::with_defaults();
        let result = cleaner.clean(&[]);

        assert!(result.smoothed_points.is_empty());
        assert!(result.simplified_indices.is_empty());
        assert_eq!(result.stats.original_points, 0);
    }
}
