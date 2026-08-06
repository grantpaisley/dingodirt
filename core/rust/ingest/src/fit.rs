//! FIT file parser
//!
//! Parses Garmin FIT format files into internal Track representation.
//! FIT files contain rich sensor data (HR, cadence, power, temperature).

use crate::track::{Track, TrackPoint, TrackType};
use chrono::{DateTime, Utc};
use fitparser::{self, FitDataField, Value, profile::MesgNum};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FitParseError {
    #[error("Failed to parse FIT file: {0}")]
    ParseError(String),

    #[error("FIT parser error: {0}")]
    FitparserError(#[from] fitparser::Error),

    #[error("No GPS records found in FIT file")]
    NoGpsData,
}

/// Metadata extracted from FIT file
#[derive(Debug, Default)]
struct FitMetadata {
    sport: Option<String>,
    sub_sport: Option<String>,
    manufacturer: Option<String>,
    product: Option<String>,
}

/// Session boundary marker
#[derive(Debug)]
struct SessionMarker {
    start_idx: usize,
    sport: Option<String>,
    sub_sport: Option<String>,
}

/// Parse FIT content into one or more tracks
pub fn parse_fit(contents: &[u8]) -> Result<Vec<Track>, FitParseError> {
    let fit_data = fitparser::from_bytes(contents)?;

    let mut all_points = Vec::new();
    let mut metadata = FitMetadata::default();
    let mut session_markers: Vec<SessionMarker> = Vec::new();
    let mut current_sport: Option<String> = None;
    let mut current_sub_sport: Option<String> = None;

    for record in fit_data {
        match record.kind() {
            MesgNum::Record => {
                // Record messages contain GPS + sensor data
                if let Some(point) = parse_record_message(record.fields()) {
                    all_points.push(point);
                }
            }
            MesgNum::Session => {
                // Session message marks end of a session - record where it ended
                let mut session_sport = None;
                let mut session_sub_sport = None;

                for field in record.fields() {
                    match field.name() {
                        "sport" => session_sport = extract_string(field.value()),
                        "sub_sport" => session_sub_sport = extract_string(field.value()),
                        _ => {}
                    }
                }

                session_markers.push(SessionMarker {
                    start_idx: all_points.len(),
                    sport: session_sport.clone(),
                    sub_sport: session_sub_sport.clone(),
                });

                // Use last session's sport/sub_sport as default
                current_sport = session_sport.or(current_sport);
                current_sub_sport = session_sub_sport.or(current_sub_sport);
            }
            MesgNum::Activity => {
                // Activity-level metadata (fallback)
                for field in record.fields() {
                    if field.name() == "sport" {
                        current_sport = current_sport.or_else(|| extract_string(field.value()));
                    }
                }
            }
            MesgNum::FileId => {
                // Device info
                for field in record.fields() {
                    match field.name() {
                        "manufacturer" => metadata.manufacturer = extract_string(field.value()),
                        "product" => {
                            metadata.product = extract_u16(field.value()).map(|v| v.to_string())
                        }
                        _ => {}
                    }
                }
            }
            MesgNum::DeviceInfo => {
                // More detailed device info (prefer this over FileId)
                for field in record.fields() {
                    match field.name() {
                        "manufacturer" => {
                            if let Some(m) = extract_string(field.value()) {
                                metadata.manufacturer = Some(m);
                            }
                        }
                        "product_name" => {
                            if let Some(p) = extract_string(field.value()) {
                                metadata.product = Some(p);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if all_points.is_empty() {
        return Err(FitParseError::NoGpsData);
    }

    // Store final sport values
    metadata.sport = current_sport;
    metadata.sub_sport = current_sub_sport;

    // Build tracks from sessions
    let tracks = if session_markers.is_empty() {
        // Single track (no explicit sessions)
        vec![build_track(&all_points, 0, all_points.len(), &metadata)]
    } else {
        // Multiple sessions - split points
        let mut tracks = Vec::new();
        let mut start = 0;

        for marker in &session_markers {
            if marker.start_idx > start {
                let mut session_meta = metadata.clone();
                session_meta.sport = marker.sport.clone().or(metadata.sport.clone());
                session_meta.sub_sport = marker.sub_sport.clone().or(metadata.sub_sport.clone());

                tracks.push(build_track(
                    &all_points,
                    start,
                    marker.start_idx,
                    &session_meta,
                ));
                start = marker.start_idx;
            }
        }

        // Any remaining points after last session marker
        if start < all_points.len() {
            tracks.push(build_track(&all_points, start, all_points.len(), &metadata));
        }

        // If we ended up with no tracks, create single track
        if tracks.is_empty() {
            vec![build_track(&all_points, 0, all_points.len(), &metadata)]
        } else {
            tracks
        }
    };

    Ok(tracks)
}

impl Clone for FitMetadata {
    fn clone(&self) -> Self {
        FitMetadata {
            sport: self.sport.clone(),
            sub_sport: self.sub_sport.clone(),
            manufacturer: self.manufacturer.clone(),
            product: self.product.clone(),
        }
    }
}

fn build_track(points: &[TrackPoint], start: usize, end: usize, metadata: &FitMetadata) -> Track {
    let track_points: Vec<TrackPoint> = points[start..end].to_vec();

    // Determine if this is a ride (has timestamps) or course
    let has_timestamps = track_points.iter().any(|p| p.time.is_some());
    let track_type = if has_timestamps {
        TrackType::Ride
    } else {
        TrackType::Route
    };

    let mut track = Track {
        name: metadata.sport.clone(),
        description: None,
        color: None,
        track_type,
        points: track_points,
        started_at: None,
        ended_at: None,
        source_format: "fit".to_string(),
        fit_sport: metadata.sport.clone(),
        fit_sub_sport: metadata.sub_sport.clone(),
        device_manufacturer: metadata.manufacturer.clone(),
        device_product: metadata.product.clone(),
    };

    track.update_time_bounds();
    track
}

/// Parse a FIT Record message into a TrackPoint
fn parse_record_message(fields: &[FitDataField]) -> Option<TrackPoint> {
    let mut lat: Option<f64> = None;
    let mut lon: Option<f64> = None;
    let mut elevation: Option<f64> = None;
    let mut time: Option<DateTime<Utc>> = None;
    let mut speed: Option<f32> = None;
    let mut heart_rate: Option<u8> = None;
    let mut cadence: Option<u8> = None;
    let mut power: Option<u16> = None;
    let mut temperature: Option<i8> = None;

    for field in fields {
        match field.name() {
            "position_lat" => {
                lat = extract_semicircles_to_degrees(field.value());
            }
            "position_long" => {
                lon = extract_semicircles_to_degrees(field.value());
            }
            "altitude" | "enhanced_altitude" => {
                // Prefer enhanced_altitude (higher resolution)
                if field.name() == "enhanced_altitude" || elevation.is_none() {
                    elevation = extract_f64(field.value());
                }
            }
            "timestamp" => {
                time = extract_timestamp(field.value());
            }
            "speed" | "enhanced_speed" => {
                // Prefer enhanced_speed
                if field.name() == "enhanced_speed" || speed.is_none() {
                    speed = extract_f32(field.value());
                }
            }
            "heart_rate" => {
                heart_rate = extract_u8(field.value());
            }
            "cadence" => {
                cadence = extract_u8(field.value());
            }
            "power" => {
                power = extract_u16(field.value());
            }
            "temperature" => {
                temperature = extract_i8(field.value());
            }
            _ => {}
        }
    }

    // Only create point if we have valid coordinates
    let lat = lat?;
    let lon = lon?;

    Some(TrackPoint {
        lat,
        lon,
        elevation,
        time,
        speed,
        heart_rate,
        cadence,
        power,
        temperature,
    })
}

/// Convert FIT semicircles to degrees
/// FIT uses semicircles: 2^31 semicircles = 180 degrees
fn extract_semicircles_to_degrees(value: &Value) -> Option<f64> {
    match value {
        Value::SInt32(v) => Some((*v as f64) * (180.0 / 2_147_483_648.0)),
        _ => None,
    }
}

fn extract_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Float32(v) => Some(*v as f64),
        Value::Float64(v) => Some(*v),
        Value::UInt16(v) => Some(*v as f64),
        Value::SInt16(v) => Some(*v as f64),
        _ => None,
    }
}

fn extract_f32(value: &Value) -> Option<f32> {
    match value {
        Value::Float32(v) => Some(*v),
        Value::Float64(v) => Some(*v as f32),
        Value::UInt16(v) => Some(*v as f32),
        _ => None,
    }
}

fn extract_u8(value: &Value) -> Option<u8> {
    match value {
        Value::UInt8(v) => Some(*v),
        _ => None,
    }
}

fn extract_u16(value: &Value) -> Option<u16> {
    match value {
        Value::UInt16(v) => Some(*v),
        _ => None,
    }
}

fn extract_i8(value: &Value) -> Option<i8> {
    match value {
        Value::SInt8(v) => Some(*v),
        _ => None,
    }
}

fn extract_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn extract_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    match value {
        Value::Timestamp(t) => Some((*t).into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semicircles_conversion() {
        // Test known conversion: 0 semicircles = 0 degrees
        assert_eq!(extract_semicircles_to_degrees(&Value::SInt32(0)), Some(0.0));

        // Test: 2^30 semicircles = 90 degrees
        let ninety_deg = (2_i32.pow(30) as f64) * (180.0 / 2_147_483_648.0);
        assert!((ninety_deg - 90.0).abs() < 0.0001);
    }
}
