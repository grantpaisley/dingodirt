//! GPS track smoothing using a simple moving average filter
//!
//! A Kalman filter would be more sophisticated, but for GPS data a moving
//! average with outlier rejection works well and is simpler to implement.

use chrono::{DateTime, Utc};

/// A point with lat/lon/elevation/time for smoothing operations
#[derive(Debug, Clone)]
pub struct GeoPoint {
    pub lat: f64,
    pub lon: f64,
    pub elevation: Option<f64>,
    pub time: Option<DateTime<Utc>>,
    pub heart_rate: Option<u8>,
}

/// Configuration for GPS smoothing
#[derive(Debug, Clone)]
pub struct SmoothConfig {
    /// Window size for moving average (odd number recommended)
    pub window_size: usize,
    /// Maximum distance (meters) a point can be from the smoothed position
    /// before being considered an outlier
    pub outlier_threshold_m: f64,
}

impl Default for SmoothConfig {
    fn default() -> Self {
        Self {
            window_size: 5,
            outlier_threshold_m: 50.0, // 50m is very generous for GPS error
        }
    }
}

/// Apply moving average smoothing to GPS coordinates
///
/// This reduces GPS jitter while preserving the overall track shape.
/// Outliers (sudden large jumps) are detected and corrected.
pub fn smooth_track(points: &[GeoPoint], config: &SmoothConfig) -> Vec<GeoPoint> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let half_window = config.window_size / 2;
    let mut smoothed = Vec::with_capacity(points.len());

    for i in 0..points.len() {
        let start = i.saturating_sub(half_window);
        let end = (i + half_window + 1).min(points.len());
        let window = &points[start..end];

        // Elevation: mean of the available readings.
        let (sum_ele, ele_count) = window.iter().fold((0.0, 0), |(ele, count), p| {
            (
                ele + p.elevation.unwrap_or(0.0),
                count + if p.elevation.is_some() { 1 } else { 0 },
            )
        });
        let avg_ele = if ele_count > 0 {
            Some(sum_ele / ele_count as f64)
        } else {
            None
        };

        // Position reference: the per-coordinate *median* of the window. A single
        // GPS spike is one value in an odd-sized window, so the median ignores it —
        // both when the spike is the point under test and when it merely sits in a
        // neighbour's window (a mean would fold the spike into every position
        // near it). Longitudes are medianed as offsets from the current point and
        // re-wrapped, so the result is also correct across the antimeridian.
        let lon0 = points[i].lon;
        let ref_lat = median(window.iter().map(|p| p.lat));
        let ref_lon = wrap_lon(lon0 + median(window.iter().map(|p| wrap_lon(p.lon - lon0))));

        // Check if original point is an outlier
        let dist = haversine_distance(points[i].lat, points[i].lon, ref_lat, ref_lon);

        let (final_lat, final_lon) = if dist > config.outlier_threshold_m {
            // Use the robust reference position instead of the original
            (ref_lat, ref_lon)
        } else {
            // Blend original with reference (70% original, 30% reference)
            (
                points[i].lat * 0.7 + ref_lat * 0.3,
                wrap_lon(lon0 + wrap_lon(ref_lon - lon0) * 0.3),
            )
        };

        smoothed.push(GeoPoint {
            lat: final_lat,
            lon: final_lon,
            elevation: avg_ele.or(points[i].elevation),
            time: points[i].time,
            heart_rate: points[i].heart_rate, // Preserve HR
        });
    }

    smoothed
}

/// Median of an iterator of finite values. Returns 0.0 for an empty input.
fn median(values: impl Iterator<Item = f64>) -> f64 {
    let mut v: Vec<f64> = values.collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// Normalise a longitude (or a longitude delta) into the range [-180, 180).
pub fn wrap_lon(lon: f64) -> f64 {
    (lon + 180.0).rem_euclid(360.0) - 180.0
}

/// Calculate distance between two points using Haversine formula
pub fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_000.0;

    let lat1_rad = lat1.to_radians();
    let lat2_rad = lat2.to_radians();
    let delta_lat = (lat2 - lat1).to_radians();
    let delta_lon = (lon2 - lon1).to_radians();

    let a = (delta_lat / 2.0).sin().powi(2)
        + lat1_rad.cos() * lat2_rad.cos() * (delta_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();

    EARTH_RADIUS_M * c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_haversine_distance() {
        // Brisbane to Sydney ~730km
        let dist = haversine_distance(-27.4698, 153.0251, -33.8688, 151.2093);
        assert!((dist - 730_000.0).abs() < 50_000.0); // Within 50km
    }

    #[test]
    fn test_smooth_removes_jitter() {
        // Create a track with one noisy point
        let points = vec![
            GeoPoint {
                lat: -27.4698,
                lon: 153.0251,
                elevation: Some(10.0),
                time: None,
                heart_rate: None,
            },
            GeoPoint {
                lat: -27.4699,
                lon: 153.0252,
                elevation: Some(10.0),
                time: None,
                heart_rate: None,
            },
            GeoPoint {
                lat: -27.4800,
                lon: 153.0350,
                elevation: Some(10.0),
                time: None,
                heart_rate: None,
            }, // Outlier
            GeoPoint {
                lat: -27.4701,
                lon: 153.0254,
                elevation: Some(10.0),
                time: None,
                heart_rate: None,
            },
            GeoPoint {
                lat: -27.4702,
                lon: 153.0255,
                elevation: Some(10.0),
                time: None,
                heart_rate: None,
            },
        ];

        let config = SmoothConfig::default();
        let smoothed = smooth_track(&points, &config);

        // The smoothed outlier should be closer to the line
        let dist_to_expected =
            haversine_distance(smoothed[2].lat, smoothed[2].lon, -27.4700, 153.0253);
        assert!(dist_to_expected < 500.0); // Should be pulled back toward the line
    }
}
