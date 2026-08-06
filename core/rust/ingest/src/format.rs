//! File format detection from magic bytes and content inspection

use std::io::Read;
use std::path::Path;

/// Supported file formats for track data
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileFormat {
    /// Garmin FIT format (binary)
    Fit,
    /// GPS Exchange Format (XML)
    Gpx,
    /// Keyhole Markup Language (XML)
    Kml,
    /// GeoJSON format
    GeoJson,
    /// Training Center XML
    Tcx,
    /// Unknown or unsupported format
    Unknown,
}

impl FileFormat {
    /// Get the standard file extension for this format
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Fit => "fit",
            Self::Gpx => "gpx",
            Self::Kml => "kml",
            Self::GeoJson => "geojson",
            Self::Tcx => "tcx",
            Self::Unknown => "bin",
        }
    }

    /// Check if this format contains timestamp data (ride vs route)
    pub fn typically_has_timestamps(&self) -> bool {
        matches!(self, Self::Fit | Self::Gpx | Self::Tcx)
    }
}

/// Detect file format from file contents
pub fn detect_format(contents: &[u8]) -> FileFormat {
    // FIT files start with header size byte, then ".FIT" at offset 8-11
    if contents.len() >= 12 && &contents[8..12] == b".FIT" {
        return FileFormat::Fit;
    }

    // For text-based formats, check the beginning as a string
    let start = String::from_utf8_lossy(&contents[..contents.len().min(1024)]);
    let start_trimmed = start.trim_start();

    // GPX: XML with <gpx> root element
    if (start_trimmed.starts_with("<?xml") || start_trimmed.starts_with("<gpx"))
        && start.contains("<gpx") {
            return FileFormat::Gpx;
        }

    // KML: XML with <kml> root element
    if (start_trimmed.starts_with("<?xml") || start_trimmed.starts_with("<kml"))
        && start.contains("<kml") {
            return FileFormat::Kml;
        }

    // TCX: XML with TrainingCenterDatabase root
    if (start_trimmed.starts_with("<?xml") || start_trimmed.starts_with("<TrainingCenterDatabase"))
        && start.contains("<TrainingCenterDatabase") {
            return FileFormat::Tcx;
        }

    // GeoJSON: JSON starting with { and containing "type" and geometry keywords
    if start_trimmed.starts_with('{')
        && start.contains("\"type\"")
            && (start.contains("\"FeatureCollection\"")
                || start.contains("\"Feature\"")
                || start.contains("\"LineString\"")
                || start.contains("\"coordinates\""))
        {
            return FileFormat::GeoJson;
        }

    FileFormat::Unknown
}

/// Detect format from a file path by reading its contents
pub fn detect_format_from_file(path: impl AsRef<Path>) -> std::io::Result<FileFormat> {
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; 4096]; // Read first 4KB for detection
    let bytes_read = file.read(&mut buffer)?;
    buffer.truncate(bytes_read);
    Ok(detect_format(&buffer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_gpx() {
        let gpx_content = br#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin">
  <trk>
    <name>Morning Ride</name>
  </trk>
</gpx>"#;
        assert_eq!(detect_format(gpx_content), FileFormat::Gpx);
    }

    #[test]
    fn test_detect_gpx_no_declaration() {
        let gpx_content = b"<gpx version=\"1.1\"><trk></trk></gpx>";
        assert_eq!(detect_format(gpx_content), FileFormat::Gpx);
    }

    #[test]
    fn test_detect_fit() {
        // FIT file magic: header size at 0, ".FIT" at offset 8
        let mut fit_content = vec![0u8; 14];
        fit_content[0] = 14; // Header size
        fit_content[8..12].copy_from_slice(b".FIT");
        assert_eq!(detect_format(&fit_content), FileFormat::Fit);
    }

    #[test]
    fn test_detect_kml() {
        let kml_content = br#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark></Placemark>
  </Document>
</kml>"#;
        assert_eq!(detect_format(kml_content), FileFormat::Kml);
    }

    #[test]
    fn test_detect_geojson() {
        let geojson = br#"{"type": "FeatureCollection", "features": []}"#;
        assert_eq!(detect_format(geojson), FileFormat::GeoJson);
    }

    #[test]
    fn test_detect_tcx() {
        let tcx_content = br#"<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities></Activities>
</TrainingCenterDatabase>"#;
        assert_eq!(detect_format(tcx_content), FileFormat::Tcx);
    }

    #[test]
    fn test_detect_unknown() {
        let random = b"just some random bytes that aren't a known format";
        assert_eq!(detect_format(random), FileFormat::Unknown);
    }
}
