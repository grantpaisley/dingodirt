//! GPX file parser
//!
//! Parses GPS Exchange Format files into internal Track representation

use crate::html::clean_description;
use crate::track::{Track, TrackPoint, TrackType};
use chrono::{DateTime, Utc};
use thiserror::Error;

/// A top-level `<wpt>` from a GPX file — a point of interest, not a track
/// point. Curated route files (e.g. the G.O.A.T networks) carry hundreds of
/// these: campgrounds, fuel, water, hazards.
#[derive(Debug, Clone, PartialEq)]
pub struct GpxWaypoint {
    pub lat: f64,
    pub lon: f64,
    pub elevation: Option<f64>,
    pub name: Option<String>,
    /// Description with HTML normalised to plain text (line breaks kept)
    pub description: Option<String>,
    /// Garmin symbol name, verbatim (e.g. "Gas Station", "Campground")
    pub sym: Option<String>,
}

/// Everything parsed from one GPX file: tracks/routes plus standalone POIs.
#[derive(Debug, Clone)]
pub struct ParsedGpx {
    pub tracks: Vec<Track>,
    pub waypoints: Vec<GpxWaypoint>,
}

#[derive(Debug, Error)]
pub enum GpxParseError {
    #[error("Failed to parse GPX: {0}")]
    ParseError(String),

    #[error("GPX library error: {0}")]
    GpxError(#[from] gpx::errors::GpxError),

    #[error("No tracks found in GPX file")]
    NoTracks,
}

/// Convert gpx::Time to chrono::DateTime<Utc>
fn gpx_time_to_chrono(time: gpx::Time) -> Option<DateTime<Utc>> {
    // gpx::Time wraps time::OffsetDateTime, convert via string format
    let formatted = time.format().ok()?;
    DateTime::parse_from_rfc3339(&formatted)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Parse GPX content into one or more tracks (legacy entry point — drops
/// waypoints; recorded-ride ingest doesn't use them)
pub fn parse_gpx(contents: &[u8]) -> Result<Vec<Track>, GpxParseError> {
    let parsed = parse_gpx_file(contents)?;
    if parsed.tracks.is_empty() {
        return Err(GpxParseError::NoTracks);
    }
    Ok(parsed.tracks)
}

/// Parse GPX content fully: tracks, routes, and top-level waypoints.
/// Errors with `NoTracks` only when the file contains neither tracks nor
/// waypoints.
pub fn parse_gpx_file(contents: &[u8]) -> Result<ParsedGpx, GpxParseError> {
    let gpx_data = gpx::read(std::io::Cursor::new(contents))?;

    // The gpx crate ignores <extensions>, so track colors come from a raw
    // pre-scan of the XML, index-aligned with gpx_data.tracks.
    let track_colors = extract_track_colors(contents);

    let mut tracks = Vec::new();

    for (trk_idx, gpx_track) in gpx_data.tracks.into_iter().enumerate() {
        let name = gpx_track.name.clone();
        let color = track_colors.get(trk_idx).cloned().flatten();

        for (seg_idx, segment) in gpx_track.segments.iter().enumerate() {
            if segment.points.is_empty() {
                continue;
            }

            let mut points = Vec::with_capacity(segment.points.len());
            let mut has_timestamps = false;

            for waypoint in &segment.points {
                let time = waypoint.time.and_then(gpx_time_to_chrono);
                if time.is_some() {
                    has_timestamps = true;
                }

                points.push(TrackPoint {
                    lat: waypoint.point().y(),
                    lon: waypoint.point().x(),
                    elevation: waypoint.elevation,
                    time,
                    speed: None,
                    heart_rate: None, // GPX extensions not parsed yet
                    cadence: None,
                    power: None,
                    temperature: None,
                });
            }

            // Generate name for multi-segment tracks
            let track_name = if gpx_track.segments.len() > 1 {
                name.as_ref()
                    .map(|n| format!("{} (segment {})", n, seg_idx + 1))
            } else {
                name.clone()
            };

            let track_type = if has_timestamps {
                TrackType::Ride
            } else {
                TrackType::Route
            };

            let mut track = Track {
                name: track_name,
                description: gpx_track.description.as_deref().map(clean_description),
                color: color.clone(),
                track_type,
                points,
                started_at: None,
                ended_at: None,
                source_format: "gpx".to_string(),
                fit_sport: None,
                fit_sub_sport: None,
                device_manufacturer: None,
                device_product: None,
            };

            track.update_time_bounds();
            tracks.push(track);
        }
    }

    // Also parse routes (geometry-only, no timestamps)
    for route in gpx_data.routes {
        if route.points.is_empty() {
            continue;
        }

        let points: Vec<TrackPoint> = route
            .points
            .iter()
            .map(|wp| TrackPoint {
                lat: wp.point().y(),
                lon: wp.point().x(),
                elevation: wp.elevation,
                time: None,
                speed: None,
                heart_rate: None,
                cadence: None,
                power: None,
                temperature: None,
            })
            .collect();

        tracks.push(Track {
            name: route.name,
            description: route.description.as_deref().map(clean_description),
            color: None,
            track_type: TrackType::Route,
            points,
            started_at: None,
            ended_at: None,
            source_format: "gpx".to_string(),
            fit_sport: None,
            fit_sub_sport: None,
            device_manufacturer: None,
            device_product: None,
        });
    }

    let waypoints: Vec<GpxWaypoint> = gpx_data
        .waypoints
        .iter()
        .map(|wp| GpxWaypoint {
            lat: wp.point().y(),
            lon: wp.point().x(),
            elevation: wp.elevation,
            name: wp.name.clone(),
            description: wp.description.as_deref().map(clean_description),
            sym: wp.symbol.clone(),
        })
        .collect();

    if tracks.is_empty() && waypoints.is_empty() {
        return Err(GpxParseError::NoTracks);
    }

    Ok(ParsedGpx { tracks, waypoints })
}

/// Extract a display color per `<trk>` by scanning the raw XML (the gpx
/// crate drops `<extensions>`). Only the track header — everything before
/// `<trkseg>` — is searched, which is where the GPX 1.1 schema places
/// track-level extensions. Result is index-aligned with the file's tracks.
fn extract_track_colors(contents: &[u8]) -> Vec<Option<String>> {
    let text = String::from_utf8_lossy(contents);
    let mut colors = Vec::new();
    let mut rest: &str = &text;

    while let Some(start) = find_trk_open(rest) {
        let after_open = &rest[start..];
        let end = after_open.find("</trk>").unwrap_or(after_open.len());
        let block = &after_open[..end];
        let header = match block.find("<trkseg") {
            Some(seg) => &block[..seg],
            None => block,
        };
        colors.push(color_from_header(header));
        rest = &after_open[end..];
        if rest.is_empty() {
            break;
        }
    }

    colors
}

fn find_trk_open(text: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(pos) = text[from..].find("<trk") {
        let abs = from + pos;
        // Accept "<trk>" or "<trk " but not "<trkseg"/"<trkpt"
        match text[abs + 4..].chars().next() {
            Some(c) if c == '>' || c.is_whitespace() => return Some(abs),
            _ => from = abs + 4,
        }
    }
    None
}

/// Look for a color value in a track header. Understands the common
/// producers: `<gpx_style:color>`, OsmAnd `<osmand:color>` / plain
/// `<color>`, and Garmin `<gpxx:DisplayColor>` named colors.
fn color_from_header(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    for tag in ["gpx_style:color", "osmand:color", "color", "gpxx:displaycolor"] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let Some(s) = lower.find(&open) else { continue };
        let val_start = s + open.len();
        let Some(e) = lower[val_start..].find(&close) else {
            continue;
        };
        // Slice the original-case header so named colors keep their casing
        if let Some(color) = normalize_color(header[val_start..val_start + e].trim()) {
            return Some(color);
        }
    }
    None
}

/// Normalise a color value to lowercase `#rrggbb`. Accepts `RRGGBB`,
/// `#RRGGBB`, `AARRGGBB`/`#AARRGGBB` (alpha stripped), and Garmin
/// DisplayColor names.
fn normalize_color(value: &str) -> Option<String> {
    let hex = value.strip_prefix('#').unwrap_or(value);
    let is_hex = !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    if is_hex {
        match hex.len() {
            6 => return Some(format!("#{}", hex.to_ascii_lowercase())),
            8 => return Some(format!("#{}", hex[2..].to_ascii_lowercase())),
            _ => {}
        }
    }
    let named = match value.to_ascii_lowercase().as_str() {
        "black" => "#000000",
        "darkred" => "#8b0000",
        "darkgreen" => "#006400",
        "darkyellow" => "#808000",
        "darkblue" => "#00008b",
        "darkmagenta" => "#8b008b",
        "darkcyan" => "#008b8b",
        "lightgray" => "#d3d3d3",
        "darkgray" => "#a9a9a9",
        "red" => "#ff0000",
        "green" => "#00ff00",
        "yellow" => "#ffff00",
        "blue" => "#0000ff",
        "magenta" => "#ff00ff",
        "cyan" => "#00ffff",
        "white" => "#ffffff",
        _ => return None,
    };
    Some(named.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_GPX: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk>
    <name>Morning Ride</name>
    <trkseg>
      <trkpt lat="-27.4698" lon="153.0251">
        <ele>10.5</ele>
        <time>2024-01-15T06:30:00Z</time>
      </trkpt>
      <trkpt lat="-27.4700" lon="153.0255">
        <ele>12.0</ele>
        <time>2024-01-15T06:30:10Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>"#;

    const ROUTE_GPX: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <rte>
    <name>Planned Route</name>
    <rtept lat="-27.5" lon="153.0"><ele>50</ele></rtept>
    <rtept lat="-27.6" lon="153.1"><ele>100</ele></rtept>
  </rte>
</gpx>"#;

    #[test]
    fn test_parse_ride() {
        let tracks = parse_gpx(SAMPLE_GPX).unwrap();
        assert_eq!(tracks.len(), 1);

        let track = &tracks[0];
        assert_eq!(track.name.as_deref(), Some("Morning Ride"));
        assert_eq!(track.track_type, TrackType::Ride);
        assert_eq!(track.points.len(), 2);
        assert!(track.started_at.is_some());

        let first_point = &track.points[0];
        assert!((first_point.lat - (-27.4698)).abs() < 0.0001);
        assert!(first_point.elevation.is_some());
        assert!(first_point.time.is_some());
    }

    #[test]
    fn test_parse_route() {
        let tracks = parse_gpx(ROUTE_GPX).unwrap();
        assert_eq!(tracks.len(), 1);

        let track = &tracks[0];
        assert_eq!(track.track_type, TrackType::Route);
        assert!(track.started_at.is_none());
    }

    fn fixture() -> Vec<u8> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../samples/planned_routes_sample.gpx"
        );
        std::fs::read(path).expect("fixture readable")
    }

    #[test]
    fn fixture_parses_tracks_and_waypoints() {
        let parsed = parse_gpx_file(&fixture()).unwrap();
        assert_eq!(parsed.tracks.len(), 3);
        assert_eq!(parsed.waypoints.len(), 6);
        // No timestamps anywhere → all planned-style routes
        assert!(
            parsed
                .tracks
                .iter()
                .all(|t| t.track_type == TrackType::Route)
        );
    }

    #[test]
    fn fixture_track_descriptions_are_cleaned() {
        let parsed = parse_gpx_file(&fixture()).unwrap();
        let goaty = &parsed.tracks[0];
        assert_eq!(goaty.name.as_deref(), Some("Test Goaty G3 12Km"));
        let desc = goaty.description.as_deref().unwrap();
        assert!(desc.contains("navigable on bikes with caution"));
        assert!(desc.contains('\n'), "br should become newline");
        assert!(!desc.contains("<br"), "no HTML left: {desc}");
        assert_eq!(parsed.tracks[2].description, None);
    }

    #[test]
    fn fixture_color_extension_is_extracted() {
        let parsed = parse_gpx_file(&fixture()).unwrap();
        assert_eq!(parsed.tracks[0].color, None);
        assert_eq!(parsed.tracks[1].color.as_deref(), Some("#d85a30"));
        assert_eq!(parsed.tracks[2].color, None);
    }

    #[test]
    fn fixture_waypoints_carry_sym_and_cleaned_desc() {
        let parsed = parse_gpx_file(&fixture()).unwrap();
        let camp = parsed
            .waypoints
            .iter()
            .find(|w| w.name.as_deref() == Some("Test Camping Area"))
            .unwrap();
        assert_eq!(camp.sym.as_deref(), Some("Campground"));
        let desc = camp.description.as_deref().unwrap();
        assert_eq!(desc, "Free camping.\nNo water in dry season.\n\nContact NPWS office.");
        assert!((camp.lat - (-28.9100075)).abs() < 1e-6);
        assert!(camp.elevation.is_some());

        let bare = parsed
            .waypoints
            .iter()
            .find(|w| w.name.as_deref() == Some("Test Bare Point"))
            .unwrap();
        assert_eq!(bare.sym, None);
        assert_eq!(bare.description, None);
    }

    #[test]
    fn waypoint_only_gpx_is_not_an_error() {
        let wpt_only = br#"<?xml version="1.0"?>
<gpx version="1.1" creator="t"><wpt lat="-28.0" lon="152.0"><name>P</name></wpt></gpx>"#;
        let parsed = parse_gpx_file(wpt_only).unwrap();
        assert!(parsed.tracks.is_empty());
        assert_eq!(parsed.waypoints.len(), 1);
        // but the legacy track-only entry point still errors
        assert!(parse_gpx(wpt_only).is_err());
    }

    #[test]
    fn normalize_color_variants() {
        assert_eq!(normalize_color("D85A30").as_deref(), Some("#d85a30"));
        assert_eq!(normalize_color("#D85A30").as_deref(), Some("#d85a30"));
        assert_eq!(normalize_color("FFD85A30").as_deref(), Some("#d85a30"));
        assert_eq!(normalize_color("#ffd85a30").as_deref(), Some("#d85a30"));
        assert_eq!(normalize_color("DarkRed").as_deref(), Some("#8b0000"));
        assert_eq!(normalize_color("nonsense"), None);
        assert_eq!(normalize_color(""), None);
    }

    #[test]
    fn osmand_and_garmin_color_forms() {
        let osmand = br#"<?xml version="1.0"?>
<gpx version="1.1" creator="OsmAnd" xmlns:osmand="https://osmand.net"><trk><name>A</name>
<extensions><osmand:color>#aa00ff00</osmand:color></extensions>
<trkseg><trkpt lat="-28.0" lon="152.0"/><trkpt lat="-28.1" lon="152.1"/></trkseg></trk></gpx>"#;
        let parsed = parse_gpx_file(osmand).unwrap();
        assert_eq!(parsed.tracks[0].color.as_deref(), Some("#00ff00"));

        let garmin = br#"<?xml version="1.0"?>
<gpx version="1.1" creator="Garmin" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3"><trk><name>B</name>
<extensions><gpxx:TrackExtension><gpxx:DisplayColor>DarkRed</gpxx:DisplayColor></gpxx:TrackExtension></extensions>
<trkseg><trkpt lat="-28.0" lon="152.0"/><trkpt lat="-28.1" lon="152.1"/></trkseg></trk></gpx>"#;
        let parsed = parse_gpx_file(garmin).unwrap();
        assert_eq!(parsed.tracks[0].color.as_deref(), Some("#8b0000"));
    }
}
