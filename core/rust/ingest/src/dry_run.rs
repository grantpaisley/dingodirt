//! Dry-run scanning — inventory a path (files, directories, zip archives)
//! WITHOUT touching the database or the file store.
//!
//! Purpose: before a bulk bootstrap import, report what's there:
//! counts by format/source, date ranges, ride vs route split, sport metadata,
//! HR coverage, exact-byte duplicates, and suspected time-window duplicates
//! (the same ride exported by both Garmin and Strava, etc.).
//!
//! Handles nested zips (Garmin GDPR exports: outer.zip → UploadedFiles_Part*.zip
//! → *.fit, and the older *_ACTIVITY.zip layout) and gzipped members
//! (Strava bulk exports: activities/*.fit.gz / *.gpx.gz).

use chrono::{DateTime, Datelike, Utc};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::Path;
use tracing::{info, warn};
use zip::ZipArchive;

use dingo_core::{Error, Result};

use crate::fit::parse_fit;
use crate::format::{FileFormat, detect_format};
use crate::gpx::parse_gpx;

/// Maximum zip nesting depth (Garmin GDPR: outer → part → activity = 3).
const MAX_ZIP_DEPTH: usize = 3;

/// Minimum overlap between two rides' time windows to suspect a duplicate.
const MIN_OVERLAP_SECS: i64 = 60;

/// One parsed track found during the scan.
#[derive(Debug, Clone)]
pub struct ScannedTrack {
    /// Where it came from, e.g. `Garmin_2025-12-28.zip!UploadedFiles_0-_Part1.zip!angrykoala_123.fit`
    pub source: String,
    pub format: FileFormat,
    pub name: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub points: usize,
    pub distance_km: f64,
    pub has_hr: bool,
    pub sport: Option<String>,
    pub sub_sport: Option<String>,
    /// true = no timestamps (a planned route, not a recorded ride)
    pub is_route: bool,
}

/// A cluster of tracks whose time windows overlap — suspected same ride.
#[derive(Debug)]
pub struct DuplicateCluster {
    /// Indices into `DryRunReport::tracks`
    pub track_indices: Vec<usize>,
    /// Index of the preferred source (FIT > TCX > GPX)
    pub winner: usize,
}

#[derive(Debug, Default)]
pub struct DryRunReport {
    pub files_scanned: usize,
    pub files_by_format: HashMap<String, usize>,
    /// Formats detected but not yet parseable (KML, TCX, GeoJSON)
    pub files_unparsed_format: usize,
    pub files_unknown_format: usize,
    pub files_no_gps: usize,
    /// Parsed fine but contained no track (e.g. waypoint-only GPX) — a skip,
    /// not a parse failure.
    pub files_no_tracks: usize,
    pub files_failed: usize,
    pub failures: Vec<(String, String)>, // (source, error)
    pub zip_members_skipped: usize,      // non-track entries inside archives
    pub tracks: Vec<ScannedTrack>,
    /// sha256 → sources; entries with >1 source are exact-byte duplicates
    pub byte_dupes: Vec<Vec<String>>,
    pub time_window_dupes: Vec<DuplicateCluster>,
    sha_seen: HashMap<String, Vec<String>>,
    limit: Option<usize>,
    limit_hit: bool,
}

impl DryRunReport {
    fn rides(&self) -> impl Iterator<Item = &ScannedTrack> {
        self.tracks.iter().filter(|t| !t.is_route)
    }

    fn at_limit(&self) -> bool {
        match self.limit {
            Some(n) => self.tracks.len() >= n,
            None => false,
        }
    }

    /// Finalize: compute byte-duplicate list and time-window clusters.
    fn finalize(&mut self) {
        self.byte_dupes = self
            .sha_seen
            .values()
            .filter(|v| v.len() > 1)
            .cloned()
            .collect();

        // Time-window overlap clustering over rides (routes have no window).
        let mut idx: Vec<usize> = (0..self.tracks.len())
            .filter(|&i| {
                !self.tracks[i].is_route
                    && self.tracks[i].started_at.is_some()
                    && self.tracks[i].ended_at.is_some()
            })
            .collect();
        idx.sort_by_key(|&i| self.tracks[i].started_at.unwrap());

        let mut clusters: Vec<Vec<usize>> = Vec::new();
        let mut current: Vec<usize> = Vec::new();
        let mut current_max_end: Option<DateTime<Utc>> = None;

        for &i in &idx {
            let start = self.tracks[i].started_at.unwrap();
            let end = self.tracks[i].ended_at.unwrap();
            match current_max_end {
                Some(max_end)
                    if (max_end - start).num_seconds() >= MIN_OVERLAP_SECS =>
                {
                    current.push(i);
                    if end > max_end {
                        current_max_end = Some(end);
                    }
                }
                _ => {
                    if current.len() > 1 {
                        clusters.push(std::mem::take(&mut current));
                    } else {
                        current.clear();
                    }
                    current.push(i);
                    current_max_end = Some(end);
                }
            }
        }
        if current.len() > 1 {
            clusters.push(current);
        }

        self.time_window_dupes = clusters
            .into_iter()
            .map(|members| {
                let winner = *members
                    .iter()
                    .min_by_key(|&&i| format_rank(self.tracks[i].format))
                    .unwrap();
                DuplicateCluster {
                    track_indices: members,
                    winner,
                }
            })
            .collect();
    }

    /// Print the human-readable report to stdout.
    pub fn print(&self) {
        let rides = self.rides().count();
        let routes = self.tracks.len() - rides;

        println!("\n🔎 Dry-run scan report (nothing was written)\n");
        println!("Files scanned:        {}", self.files_scanned);
        let mut fmts: Vec<_> = self.files_by_format.iter().collect();
        fmts.sort_by(|a, b| b.1.cmp(a.1));
        for (fmt, n) in fmts {
            println!("   {fmt:<10} {n}");
        }
        if self.files_unparsed_format > 0 {
            println!(
                "   (of which {} are formats detected but not yet parsed: KML/TCX/GeoJSON)",
                self.files_unparsed_format
            );
        }
        if self.files_unknown_format > 0 {
            println!("Unknown format:       {}", self.files_unknown_format);
        }
        if self.zip_members_skipped > 0 {
            println!("Zip members skipped:  {} (non-track entries)", self.zip_members_skipped);
        }
        if self.files_no_gps > 0 {
            println!("No GPS data:          {}", self.files_no_gps);
        }
        if self.files_no_tracks > 0 {
            println!("No tracks (waypts):   {}", self.files_no_tracks);
        }
        if self.files_failed > 0 {
            println!("Failed to parse:      {}", self.files_failed);
            for (src, err) in self.failures.iter().take(10) {
                println!("   ❌ {src}: {err}");
            }
            if self.failures.len() > 10 {
                println!("   … and {} more", self.failures.len() - 10);
            }
        }

        println!("\nTracks found:         {} ({} rides, {} routes/plans)", self.tracks.len(), rides, routes);

        // Date range + per-year histogram
        let starts: Vec<DateTime<Utc>> =
            self.rides().filter_map(|t| t.started_at).collect();
        if let (Some(min), Some(max)) = (starts.iter().min(), starts.iter().max()) {
            println!("Date range:           {} → {}", min.format("%Y-%m-%d"), max.format("%Y-%m-%d"));
            let mut by_year: HashMap<i32, usize> = HashMap::new();
            for s in &starts {
                *by_year.entry(s.year()).or_default() += 1;
            }
            let mut years: Vec<_> = by_year.into_iter().collect();
            years.sort();
            for (y, n) in years {
                println!("   {y}  {n:>5}  {}", "▇".repeat((n as f64).sqrt().ceil() as usize));
            }
        }

        // Sport metadata (from FIT)
        let mut by_sport: HashMap<String, usize> = HashMap::new();
        for t in self.rides() {
            let key = match (&t.sport, &t.sub_sport) {
                (Some(s), Some(ss)) => format!("{s}/{ss}"),
                (Some(s), None) => s.clone(),
                _ => "(no metadata)".to_string(),
            };
            *by_sport.entry(key).or_default() += 1;
        }
        let mut sports: Vec<_> = by_sport.into_iter().collect();
        sports.sort_by(|a, b| b.1.cmp(&a.1));
        println!("\nSport metadata (classification input):");
        for (s, n) in sports.iter().take(15) {
            println!("   {s:<30} {n}");
        }
        if sports.len() > 15 {
            println!("   … and {} more types", sports.len() - 15);
        }

        let with_hr = self.rides().filter(|t| t.has_hr).count();
        if rides > 0 {
            println!(
                "\nHR coverage:          {}/{} rides ({:.0}%)",
                with_hr,
                rides,
                100.0 * with_hr as f64 / rides as f64
            );
            let total_km: f64 = self.rides().map(|t| t.distance_km).sum();
            println!("Total distance:       {total_km:.0} km");
        }

        // Duplicates
        if !self.byte_dupes.is_empty() {
            let extra: usize = self.byte_dupes.iter().map(|v| v.len() - 1).sum();
            println!(
                "\nExact-byte duplicates: {} groups ({} redundant files — content-hash will skip these)",
                self.byte_dupes.len(),
                extra
            );
            for group in self.byte_dupes.iter().take(5) {
                println!("   = {}", group.join("\n     "));
            }
        }

        if !self.time_window_dupes.is_empty() {
            let losers: usize = self
                .time_window_dupes
                .iter()
                .map(|c| c.track_indices.len() - 1)
                .sum();
            println!(
                "\nSuspected time-window duplicates: {} clusters ({} tracks would be deduped, FIT preferred)",
                self.time_window_dupes.len(),
                losers
            );
            for c in self.time_window_dupes.iter().take(10) {
                let w = &self.tracks[c.winner];
                println!(
                    "   ⏱  {} — keep {:?} [{}]",
                    w.started_at.map(|t| t.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default(),
                    w.format,
                    w.source
                );
                for &i in &c.track_indices {
                    if i != c.winner {
                        let t = &self.tracks[i];
                        println!("        drop {:?} [{}]", t.format, t.source);
                    }
                }
            }
            if self.time_window_dupes.len() > 10 {
                println!("   … and {} more clusters", self.time_window_dupes.len() - 10);
            }
        }

        let unique_rides = rides
            - self
                .time_window_dupes
                .iter()
                .map(|c| c.track_indices.len() - 1)
                .sum::<usize>();
        println!("\n➡️  Estimated unique rides after dedup: {unique_rides}");
        if self.limit_hit {
            println!("⚠️  Scan limit reached — figures are partial.");
        }
    }
}

fn format_rank(f: FileFormat) -> u8 {
    match f {
        FileFormat::Fit => 0,
        FileFormat::Tcx => 1,
        FileFormat::Gpx => 2,
        _ => 3,
    }
}

fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0;
    let (dlat, dlon) = ((lat2 - lat1).to_radians(), (lon2 - lon1).to_radians());
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R * a.sqrt().asin()
}

/// Scan a file or directory tree without writing anything.
pub fn dry_run_scan(path: &Path, limit: Option<usize>) -> Result<DryRunReport> {
    let mut report = DryRunReport {
        limit,
        ..Default::default()
    };
    scan_path(path, &mut report)?;
    report.finalize();
    Ok(report)
}

fn scan_path(path: &Path, report: &mut DryRunReport) -> Result<()> {
    if report.at_limit() {
        report.limit_hit = true;
        return Ok(());
    }
    if path.is_dir() {
        let mut entries: Vec<_> = std::fs::read_dir(path)
            .map_err(Error::Io)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        entries.sort();
        for p in entries {
            scan_path(&p, report)?;
        }
        return Ok(());
    }

    let name = path.to_string_lossy().to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    match ext.as_deref() {
        Some("zip") => {
            let contents = std::fs::read(path).map_err(Error::Io)?;
            scan_zip(&name, contents, 1, report);
        }
        Some("gz") => {
            let contents = std::fs::read(path).map_err(Error::Io)?;
            scan_gz(&name, &contents, 1, report);
        }
        Some("gpx") | Some("fit") | Some("kml") | Some("geojson") | Some("tcx") => {
            let contents = std::fs::read(path).map_err(Error::Io)?;
            scan_bytes(&name, &contents, report);
        }
        _ => {} // silently ignore unrelated loose files (html, csv, …)
    }
    Ok(())
}

fn scan_gz(name: &str, contents: &[u8], depth: usize, report: &mut DryRunReport) {
    let mut decoder = GzDecoder::new(contents);
    let mut out = Vec::new();
    match decoder.read_to_end(&mut out) {
        Ok(_) => {
            let inner_name = name.strip_suffix(".gz").unwrap_or(name).to_string();
            // A .zip could theoretically hide inside a .gz; treat by content.
            if out.len() >= 4 && &out[..4] == b"PK\x03\x04" && depth < MAX_ZIP_DEPTH {
                scan_zip(&inner_name, out, depth + 1, report);
            } else {
                scan_bytes(&inner_name, &out, report);
            }
        }
        Err(e) => {
            report.files_failed += 1;
            report.failures.push((name.to_string(), format!("gzip: {e}")));
        }
    }
}

fn scan_zip(name: &str, contents: Vec<u8>, depth: usize, report: &mut DryRunReport) {
    let mut archive = match ZipArchive::new(Cursor::new(contents)) {
        Ok(a) => a,
        Err(e) => {
            report.files_failed += 1;
            report.failures.push((name.to_string(), format!("zip: {e}")));
            return;
        }
    };

    let total = archive.len();
    info!(archive = %name, entries = total, depth, "Scanning archive");

    for i in 0..total {
        if report.at_limit() {
            report.limit_hit = true;
            return;
        }
        let entry_name = match archive.by_index_raw(i) {
            Ok(e) if !e.is_dir() => e.name().to_string(),
            _ => continue,
        };
        let lower = entry_name.to_lowercase();
        let source = format!("{name}!{entry_name}");

        let is_track = lower.ends_with(".gpx")
            || lower.ends_with(".fit")
            || lower.ends_with(".kml")
            || lower.ends_with(".geojson")
            || lower.ends_with(".tcx");
        let is_gz = lower.ends_with(".gz");
        let is_zip = lower.ends_with(".zip");

        if !is_track && !is_gz && !is_zip {
            report.zip_members_skipped += 1;
            continue;
        }

        if is_zip && depth >= MAX_ZIP_DEPTH {
            report.zip_members_skipped += 1;
            continue;
        }

        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                report.files_failed += 1;
                report.failures.push((source, format!("zip entry: {e}")));
                continue;
            }
        };
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if let Err(e) = entry.read_to_end(&mut bytes) {
            report.files_failed += 1;
            report.failures.push((source, format!("read: {e}")));
            continue;
        }

        if is_zip {
            scan_zip(&source, bytes, depth + 1, report);
        } else if is_gz {
            scan_gz(&source, &bytes, depth, report);
        } else {
            scan_bytes(&source, &bytes, report);
        }

        if report.files_scanned > 0 && report.files_scanned % 500 == 0 {
            info!(scanned = report.files_scanned, tracks = report.tracks.len(), "Scan progress");
        }
    }
}

fn scan_bytes(source: &str, contents: &[u8], report: &mut DryRunReport) {
    report.files_scanned += 1;

    let hash = hex::encode(Sha256::digest(contents));
    report
        .sha_seen
        .entry(hash)
        .or_default()
        .push(source.to_string());

    let format = detect_format(contents);
    *report
        .files_by_format
        .entry(format!("{format:?}").to_lowercase())
        .or_default() += 1;

    let tracks = match format {
        FileFormat::Gpx => parse_gpx(contents).map_err(|e| e.to_string()),
        FileFormat::Fit => parse_fit(contents).map_err(|e| e.to_string()),
        FileFormat::Unknown => {
            report.files_unknown_format += 1;
            return;
        }
        _ => {
            report.files_unparsed_format += 1;
            return;
        }
    };

    let tracks = match tracks {
        Ok(t) => t,
        Err(e) => {
            if e.contains("No GPS") {
                report.files_no_gps += 1;
            } else if e.contains("No tracks") {
                // Waypoint-only GPX (no <trk>): legitimately produces no ride —
                // a skip, not a parse failure.
                report.files_no_tracks += 1;
            } else {
                report.files_failed += 1;
                report.failures.push((source.to_string(), e));
            }
            return;
        }
    };

    for track in tracks {
        let mut distance_m = 0.0;
        for w in track.points.windows(2) {
            distance_m += haversine_m(w[0].lat, w[0].lon, w[1].lat, w[1].lon);
        }
        let is_route = track.started_at.is_none();
        report.tracks.push(ScannedTrack {
            source: source.to_string(),
            format,
            name: track.name.clone(),
            started_at: track.started_at,
            ended_at: track.ended_at,
            points: track.points.len(),
            distance_km: distance_m / 1000.0,
            has_hr: track.points.iter().any(|p| p.heart_rate.is_some()),
            sport: track.fit_sport.clone(),
            sub_sport: track.fit_sub_sport.clone(),
            is_route,
        });
    }

    if report.tracks.is_empty() && report.files_scanned == 1 {
        warn!(source, "First file produced no tracks");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn samples_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../samples")
    }

    #[test]
    fn scans_sample_fixtures() {
        let report = dry_run_scan(&samples_dir(), None).expect("scan should succeed");
        assert!(report.files_scanned >= 1, "expected sample files to be scanned");
        assert!(!report.tracks.is_empty(), "expected at least one track");
        assert_eq!(report.files_failed, 0, "failures: {:?}", report.failures);
    }

    #[test]
    fn overlap_clustering_finds_duplicates() {
        let mut report = DryRunReport::default();
        let base = Utc::now();
        for (offset, fmt, src) in [
            (0i64, FileFormat::Fit, "a.fit"),
            (30, FileFormat::Gpx, "a.gpx"), // overlaps a.fit
            (7200, FileFormat::Gpx, "b.gpx"), // separate ride
        ] {
            report.tracks.push(ScannedTrack {
                source: src.to_string(),
                format: fmt,
                name: None,
                started_at: Some(base + chrono::Duration::seconds(offset)),
                ended_at: Some(base + chrono::Duration::seconds(offset + 3600)),
                points: 10,
                distance_km: 1.0,
                has_hr: false,
                sport: None,
                sub_sport: None,
                is_route: false,
            });
        }
        report.finalize();
        assert_eq!(report.time_window_dupes.len(), 1);
        let cluster = &report.time_window_dupes[0];
        assert_eq!(cluster.track_indices.len(), 2);
        assert_eq!(report.tracks[cluster.winner].format, FileFormat::Fit);
    }
}
