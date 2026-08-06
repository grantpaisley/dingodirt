//! Track simplification using Ramer-Douglas-Peucker algorithm
//!
//! Reduces the number of points while preserving the overall shape of the track.

use crate::smooth::{GeoPoint, haversine_distance};

/// Configuration for track simplification
#[derive(Debug, Clone)]
pub struct SimplifyConfig {
    /// Maximum distance in meters a point can be from the simplified line
    /// Smaller = more detail preserved, more points kept
    pub epsilon_m: f64,
}

impl Default for SimplifyConfig {
    fn default() -> Self {
        Self {
            epsilon_m: 3.0, // 3m tolerance - preserves trail detail
        }
    }
}

/// Simplify a track using Ramer-Douglas-Peucker algorithm
///
/// Returns indices of points to keep from the original track.
pub fn simplify_track(points: &[GeoPoint], config: &SimplifyConfig) -> Vec<usize> {
    if points.len() <= 2 {
        return (0..points.len()).collect();
    }

    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;

    rdp_recursive(points, 0, points.len() - 1, config.epsilon_m, &mut keep);

    keep.iter()
        .enumerate()
        .filter_map(|(i, &k)| if k { Some(i) } else { None })
        .collect()
}

/// Recursive RDP implementation
fn rdp_recursive(points: &[GeoPoint], start: usize, end: usize, epsilon: f64, keep: &mut [bool]) {
    if end <= start + 1 {
        return;
    }

    // Find point with maximum distance from line segment
    let mut max_dist = 0.0;
    let mut max_idx = start;

    for i in (start + 1)..end {
        let dist = perpendicular_distance(&points[i], &points[start], &points[end]);
        if dist > max_dist {
            max_dist = dist;
            max_idx = i;
        }
    }

    // If max distance exceeds epsilon, keep the point and recurse
    if max_dist > epsilon {
        keep[max_idx] = true;
        rdp_recursive(points, start, max_idx, epsilon, keep);
        rdp_recursive(points, max_idx, end, epsilon, keep);
    }
}

/// Calculate perpendicular distance from point to line segment
fn perpendicular_distance(point: &GeoPoint, line_start: &GeoPoint, line_end: &GeoPoint) -> f64 {
    let line_len = haversine_distance(line_start.lat, line_start.lon, line_end.lat, line_end.lon);

    if line_len < 0.001 {
        // Line segment is essentially a point
        return haversine_distance(point.lat, point.lon, line_start.lat, line_start.lon);
    }

    // Use cross-track distance formula
    // This is an approximation that works well for short distances
    let d_start = haversine_distance(line_start.lat, line_start.lon, point.lat, point.lon);
    let d_end = haversine_distance(line_end.lat, line_end.lon, point.lat, point.lon);

    // Check if point projects onto the line segment
    let along_track = ((d_start.powi(2) + line_len.powi(2) - d_end.powi(2)) / (2.0 * line_len))
        .clamp(0.0, line_len);

    // Perpendicular distance using Pythagorean theorem
    let perp_dist_sq = d_start.powi(2) - along_track.powi(2);
    if perp_dist_sq < 0.0 {
        0.0
    } else {
        perp_dist_sq.sqrt()
    }
}

/// Apply simplification and return simplified points
pub fn simplify_and_extract(points: &[GeoPoint], config: &SimplifyConfig) -> Vec<GeoPoint> {
    let indices = simplify_track(points, config);
    indices.iter().map(|&i| points[i].clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simplify_straight_line() {
        // Points in a straight line should reduce to just start and end
        let points: Vec<GeoPoint> = (0..10)
            .map(|i| GeoPoint {
                lat: -27.4698 - (i as f64 * 0.0001),
                lon: 153.0251 + (i as f64 * 0.0001),
                elevation: None,
                time: None,
                heart_rate: None,
            })
            .collect();

        let config = SimplifyConfig { epsilon_m: 5.0 };
        let indices = simplify_track(&points, &config);

        // Should keep start and end, maybe a few in between
        assert!(indices.len() <= 4);
        assert_eq!(indices[0], 0);
        assert_eq!(*indices.last().unwrap(), points.len() - 1);
    }

    #[test]
    fn test_simplify_keeps_corners() {
        // L-shaped path should keep the corner
        let points = vec![
            GeoPoint {
                lat: -27.4698,
                lon: 153.0251,
                elevation: None,
                time: None,
                heart_rate: None,
            },
            GeoPoint {
                lat: -27.4699,
                lon: 153.0251,
                elevation: None,
                time: None,
                heart_rate: None,
            },
            GeoPoint {
                lat: -27.4700,
                lon: 153.0251,
                elevation: None,
                time: None,
                heart_rate: None,
            }, // Corner
            GeoPoint {
                lat: -27.4700,
                lon: 153.0252,
                elevation: None,
                time: None,
                heart_rate: None,
            },
            GeoPoint {
                lat: -27.4700,
                lon: 153.0253,
                elevation: None,
                time: None,
                heart_rate: None,
            },
        ];

        let config = SimplifyConfig { epsilon_m: 1.0 };
        let indices = simplify_track(&points, &config);

        // Should keep at least start, corner, and end
        assert!(indices.contains(&0));
        assert!(indices.contains(&2)); // Corner
        assert!(indices.contains(&4));
    }
}
