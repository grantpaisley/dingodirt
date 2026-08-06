//! Google Maps URL import — a shared directions link becomes a plan.
//!
//! Design: Docs/plans/2026-08-03-gmaps-import-turn-cues-design.md. The URL
//! only carries the ordered stops (names in the path, precise lat/lons in
//! the `data=` blob); the road-following geometry lives on Google's servers,
//! so the extracted waypoints are fed to the Routes API and the returned
//! polyline is synthesized into a timestamp-free GPX — which the normal
//! import pipeline then classifies as a plan (`TrackType::Route`).

use serde_json::json;
use std::fmt::Write as _;

use dingo_core::{Error, Result};

/// A parsed `/maps/dir/` URL: ordered waypoints + travel mode.
#[derive(Debug, PartialEq)]
pub struct DirRequest {
    pub waypoints: Vec<Waypoint>,
    /// Routes API travel mode ("DRIVE" | "BICYCLE" | "WALK")
    pub travel_mode: &'static str,
}

/// One stop. Precise coordinates come from the `data=` blob when present;
/// the name (path segment) is kept for the GPX metadata and as an address
/// fallback for the Routes API.
#[derive(Debug, Clone, PartialEq)]
pub struct Waypoint {
    pub name: String,
    pub coord: Option<(f64, f64)>, // (lat, lon)
}

/// Follow a share link (`maps.app.goo.gl/…`) to the full `/maps/dir/` URL.
/// Full URLs pass straight through without a network round trip.
pub async fn resolve_url(url: &str) -> Result<String> {
    if url.contains("/maps/dir/") {
        return Ok(url.to_string());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| Error::InvalidInput(format!("http client: {e}")))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| Error::InvalidInput(format!("could not resolve link: {e}")))?;
    Ok(resp.url().to_string())
}

/// Parse a full Google Maps directions URL.
pub fn parse_dir_url(url: &str) -> Result<DirRequest> {
    let after = url
        .split("/maps/dir/")
        .nth(1)
        .ok_or_else(|| Error::InvalidInput(
            "not a Google Maps directions link (expected …/maps/dir/…)".into(),
        ))?;

    // Path segments up to `@` (map viewport) or `data=` are the stops.
    let mut names: Vec<String> = Vec::new();
    for seg in after.split('/') {
        if seg.starts_with('@') || seg.starts_with("data=") {
            break;
        }
        if seg.is_empty() {
            continue;
        }
        let seg = seg.split('?').next().unwrap_or(seg);
        names.push(percent_decode(seg));
    }
    if names.is_empty() {
        return Err(Error::InvalidInput(
            "directions link has no waypoints".into(),
        ));
    }

    // Precise stop coordinates from the data blob: `!3d<lat>!4d<lon>` pairs,
    // in stop order. (The `!8m2` group preceding each pair is the stop's
    // resolved place location.)
    let data = url.split("data=").nth(1).unwrap_or("");
    let coords = extract_coord_pairs(data);

    let travel_mode = match data.split("!3e").nth(1).and_then(|s| s.chars().next()) {
        Some('1') => "BICYCLE",
        Some('2') => "WALK",
        _ => "DRIVE",
    };

    let waypoints = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            // A stop typed as raw coordinates ("‑33.7,151.0") carries its
            // own position even without a data blob.
            let coord = coords.get(i).copied().or_else(|| parse_latlng(name));
            Waypoint {
                name: name.clone(),
                coord,
            }
        })
        .collect();

    Ok(DirRequest {
        waypoints,
        travel_mode,
    })
}

fn extract_coord_pairs(data: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut rest = data;
    while let Some(i) = rest.find("!3d") {
        rest = &rest[i + 3..];
        let lat_str: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.')
            .collect();
        let Some(j) = rest.find("!4d") else { break };
        let lon_rest = &rest[j + 3..];
        let lon_str: String = lon_rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.')
            .collect();
        if let (Ok(lat), Ok(lon)) = (lat_str.parse(), lon_str.parse()) {
            out.push((lat, lon));
        }
        rest = lon_rest;
    }
    out
}

fn parse_latlng(s: &str) -> Option<(f64, f64)> {
    let (a, b) = s.split_once(',')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

fn percent_decode(seg: &str) -> String {
    let seg = seg.replace('+', " ");
    let bytes = seg.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&seg[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Call the Routes API and return the route as (lat, lon) points.
pub async fn compute_route(req: &DirRequest, api_key: &str) -> Result<Vec<(f64, f64)>> {
    if req.waypoints.len() < 2 {
        return Err(Error::InvalidInput(
            "need at least an origin and a destination".into(),
        ));
    }
    let wp_json = |w: &Waypoint| match w.coord {
        Some((lat, lon)) => json!({
            "location": {"latLng": {"latitude": lat, "longitude": lon}}
        }),
        None => json!({"address": w.name}),
    };
    let origin = wp_json(&req.waypoints[0]);
    let destination = wp_json(req.waypoints.last().unwrap());
    let intermediates: Vec<serde_json::Value> = req.waypoints
        [1..req.waypoints.len() - 1]
        .iter()
        .map(wp_json)
        .collect();

    let body = json!({
        "origin": origin,
        "destination": destination,
        "intermediates": intermediates,
        "travelMode": req.travel_mode,
        "polylineQuality": "HIGH_QUALITY",
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://routes.googleapis.com/directions/v2:computeRoutes")
        .header("X-Goog-Api-Key", api_key)
        .header(
            "X-Goog-FieldMask",
            "routes.polyline.encodedPolyline,routes.distanceMeters",
        )
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::InvalidInput(format!("Routes API request failed: {e}")))?;

    let status = resp.status();
    let payload: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| Error::InvalidInput(format!("Routes API bad response: {e}")))?;
    if !status.is_success() {
        let msg = payload["error"]["message"]
            .as_str()
            .unwrap_or("unknown error");
        return Err(Error::InvalidInput(format!(
            "Routes API error ({status}): {msg}"
        )));
    }

    let encoded = payload["routes"][0]["polyline"]["encodedPolyline"]
        .as_str()
        .ok_or_else(|| Error::InvalidInput("Routes API returned no route".into()))?;
    Ok(decode_polyline(encoded))
}

/// Decode a Google encoded polyline (precision 1e-5) into (lat, lon) points.
pub fn decode_polyline(encoded: &str) -> Vec<(f64, f64)> {
    let bytes = encoded.as_bytes();
    let mut points = Vec::new();
    let (mut i, mut lat, mut lon) = (0usize, 0i64, 0i64);
    let mut next = |i: &mut usize| -> Option<i64> {
        let (mut result, mut shift) = (0i64, 0u32);
        loop {
            let b = *bytes.get(*i)? as i64 - 63;
            *i += 1;
            result |= (b & 0x1f) << shift;
            shift += 5;
            if b < 0x20 {
                break;
            }
        }
        Some(if result & 1 != 0 {
            !(result >> 1)
        } else {
            result >> 1
        })
    };
    while i < bytes.len() {
        let Some(dlat) = next(&mut i) else { break };
        let Some(dlon) = next(&mut i) else { break };
        lat += dlat;
        lon += dlon;
        points.push((lat as f64 * 1e-5, lon as f64 * 1e-5));
    }
    points
}

/// Synthesize a timestamp-free GPX (=> `TrackType::Route`, a plan) from the
/// routed points. Metadata records the source URL and the stop names.
pub fn build_route_gpx(req: &DirRequest, source_url: &str, points: &[(f64, f64)]) -> String {
    let names: Vec<&str> = req.waypoints.iter().map(|w| w.name.as_str()).collect();
    let title = route_title(&names);
    let desc = format!("Imported from Google Maps: {}", source_url);

    let mut gpx = String::with_capacity(points.len() * 48 + 512);
    gpx.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    gpx.push_str(
        "<gpx version=\"1.1\" creator=\"Dingo\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n",
    );
    let _ = writeln!(
        gpx,
        "  <metadata><name>{}</name><desc>{}</desc></metadata>",
        xml_escape(&title),
        xml_escape(&desc)
    );
    let _ = writeln!(gpx, "  <trk><name>{}</name>", xml_escape(&title));
    gpx.push_str("    <trkseg>\n");
    for (lat, lon) in points {
        let _ = writeln!(gpx, "      <trkpt lat=\"{lat:.5}\" lon=\"{lon:.5}\"></trkpt>");
    }
    gpx.push_str("    </trkseg>\n  </trk>\n</gpx>\n");
    gpx
}

/// "A loop via B" when start == end, else "A to B (via …)" — the naming
/// pipeline will still generate a locality name later; this is the
/// original_name the import keeps.
fn route_title(names: &[&str]) -> String {
    match names {
        [] => "Google Maps route".to_string(),
        [only] => format!("Google Maps route: {only}"),
        [first, .., last] if first == last && names.len() > 2 => {
            format!("{first} loop via {}", names[1])
        }
        [first, .., last] => format!("{first} to {last}"),
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Grant's example: the Greenbank Dr loop, resolved from
    // https://maps.app.goo.gl/452uG78w5P8SiX416
    const GREENBANK: &str = "https://www.google.com/maps/dir/90+Greenbank+Dr/Northholm+Grammar+School/ALDI/90+Greenbank+Dr/data=!4m28!4m27!1m5!1m4!1s0x6b12a05696d06f8f:0xab2056fba01097f!8m2!3d-33.7061969!4d150.99651559999998!1m5!1m4!1s0x6b0d5bfd9a027ccb:0x2ec06aa905ec3e31!8m2!3d-33.604513!4d151.0540723!1m5!1m4!1s0x6b0d5f2d5acf5e0b:0x130eff4389d855dc!8m2!3d-33.652563!4d151.046464!1m5!1m4!1s0x6b12a05696d06f8f:0xab2056fba01097f!8m2!3d-33.7061969!4d150.99651559999998!2m1!11b1!3e0?utm_source=mstt_0";

    #[test]
    fn parses_greenbank_loop() {
        let req = parse_dir_url(GREENBANK).unwrap();
        assert_eq!(req.travel_mode, "DRIVE");
        assert_eq!(req.waypoints.len(), 4);
        assert_eq!(req.waypoints[0].name, "90 Greenbank Dr");
        assert_eq!(req.waypoints[1].name, "Northholm Grammar School");
        assert_eq!(req.waypoints[2].name, "ALDI");
        let (lat, lon) = req.waypoints[0].coord.unwrap();
        assert!((lat - -33.7061969).abs() < 1e-6);
        assert!((lon - 150.9965156).abs() < 1e-6);
        let (lat2, _) = req.waypoints[2].coord.unwrap();
        assert!((lat2 - -33.652563).abs() < 1e-6);
    }

    #[test]
    fn cycling_mode_and_viewport_stop() {
        let url = "https://www.google.com/maps/dir/A+St/B+Rd/@-33.7,151.0,12z/data=!3e1";
        let req = parse_dir_url(url).unwrap();
        assert_eq!(req.travel_mode, "BICYCLE");
        assert_eq!(req.waypoints.len(), 2);
        assert!(req.waypoints[0].coord.is_none());
    }

    #[test]
    fn raw_latlng_stop_parses_coordinates() {
        let url = "https://www.google.com/maps/dir/-33.70,150.99/-33.60,151.05/";
        let req = parse_dir_url(url).unwrap();
        assert_eq!(req.waypoints[0].coord, Some((-33.70, 150.99)));
        assert_eq!(req.waypoints[1].coord, Some((-33.60, 151.05)));
    }

    #[test]
    fn rejects_non_directions_url() {
        assert!(parse_dir_url("https://www.google.com/maps/place/Sydney").is_err());
    }

    #[test]
    fn polyline_round_trip() {
        // Google's documented example: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453)
        let pts = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
        assert_eq!(pts.len(), 3);
        assert!((pts[0].0 - 38.5).abs() < 1e-9);
        assert!((pts[0].1 - -120.2).abs() < 1e-9);
        assert!((pts[2].0 - 43.252).abs() < 1e-9);
        assert!((pts[2].1 - -126.453).abs() < 1e-9);
    }

    #[test]
    fn gpx_has_no_timestamps_and_carries_source() {
        let req = parse_dir_url(GREENBANK).unwrap();
        let gpx = build_route_gpx(&req, "https://maps.app.goo.gl/x", &[(-33.7, 150.99), (-33.6, 151.05)]);
        assert!(gpx.contains("<trkpt lat=\"-33.70000\" lon=\"150.99000\">"));
        assert!(!gpx.contains("<time>"));
        assert!(gpx.contains("Imported from Google Maps: https://maps.app.goo.gl/x"));
        assert!(gpx.contains("90 Greenbank Dr loop via Northholm Grammar School"));
    }
}
