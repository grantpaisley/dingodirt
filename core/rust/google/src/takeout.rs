//! Google Takeout photo import
//!
//! Walks an extracted Takeout archive, pairs media files with their JSON
//! sidecars, generates local thumbnail (200px) and medium (800px) JPEGs into
//! the content-addressed photo store, and inserts rows into `photos`.
//!
//! Full-resolution originals are NOT stored — the sidecar's `url` field links
//! back to the photo in Google Photos.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tracing::{debug, info, warn};

use dingo_core::{PhotoId, Result};

/// Long-edge sizes for locally stored renditions
const THUMB_PX: u32 = 200;
const MEDIUM_PX: u32 = 800;
const JPEG_QUALITY: u8 = 80;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff"];
const HEIC_EXTENSIONS: &[&str] = &["heic", "heif"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "avi", "mpg", "3gp", "webm", "mkv"];

#[derive(Debug, Default)]
pub struct ImportSummary {
    pub scanned: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub videos_skipped: usize,
    pub edited_skipped: usize,
    pub no_sidecar: usize,
    pub failed: usize,
}

/// Takeout sidecar JSON (only the fields we care about)
#[derive(Debug, Deserialize)]
struct Sidecar {
    title: Option<String>,
    #[serde(rename = "photoTakenTime")]
    photo_taken_time: Option<TakeoutTime>,
    #[serde(rename = "geoData")]
    geo_data: Option<TakeoutGeo>,
    #[serde(rename = "geoDataExif")]
    geo_data_exif: Option<TakeoutGeo>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TakeoutTime {
    /// Epoch seconds as a string
    timestamp: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TakeoutGeo {
    latitude: Option<f64>,
    longitude: Option<f64>,
}

/// Metadata resolved for one media file
#[derive(Debug, Default, Clone)]
struct PhotoMeta {
    taken_at: Option<DateTime<Utc>>,
    lat_lon: Option<(f64, f64)>,
    url: Option<String>,
}

impl Sidecar {
    fn into_meta(self) -> PhotoMeta {
        let taken_at = self
            .photo_taken_time
            .and_then(|t| t.timestamp)
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(|epoch| DateTime::from_timestamp(epoch, 0));

        // Takeout writes 0.0/0.0 when there is no location
        let geo = |g: Option<TakeoutGeo>| {
            g.and_then(|g| match (g.latitude, g.longitude) {
                (Some(lat), Some(lon)) if lat != 0.0 || lon != 0.0 => Some((lat, lon)),
                _ => None,
            })
        };
        let lat_lon = geo(self.geo_data).or_else(|| geo(self.geo_data_exif));

        PhotoMeta {
            taken_at,
            lat_lon,
            url: self.url,
        }
    }
}

/// Import photos from an extracted Takeout directory tree.
pub async fn import_takeout(
    pool: &PgPool,
    photo_store: &Path,
    root: &Path,
    limit: Option<usize>,
) -> Result<ImportSummary> {
    std::fs::create_dir_all(photo_store)?;
    let mut summary = ImportSummary::default();

    // Group entries per directory so sidecar lookup stays album-scoped
    let mut dirs: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.into_path();
        if let Some(parent) = path.parent() {
            dirs.entry(parent.to_path_buf()).or_default().push(path);
        }
    }

    'outer: for files in dirs.values() {
        // Parse every sidecar in this directory, indexed by the media filename
        // it describes (the JSON `title` field, with filename-based fallback).
        let mut sidecars: HashMap<String, PhotoMeta> = HashMap::new();
        for f in files.iter().filter(|f| has_ext(f, &["json"])) {
            let Ok(bytes) = std::fs::read(f) else { continue };
            let Ok(sc) = serde_json::from_slice::<Sidecar>(&bytes) else {
                continue;
            };
            if sc.photo_taken_time.is_none() && sc.title.is_none() {
                continue; // album metadata / print orders etc.
            }
            let title = sc.title.clone();
            let meta = sc.into_meta();
            // Primary key: the title (original filename)
            if let Some(t) = &title {
                sidecars.entry(t.clone()).or_insert_with(|| meta.clone());
            }
            // Fallback key: sidecar filename with `.json` (and the
            // `.supplemental-metadata` style infix) stripped — catches
            // truncated titles and `(N)` duplicate naming.
            if let Some(derived) = media_name_from_sidecar(f) {
                sidecars.entry(derived).or_insert(meta);
            }
        }

        for media in files {
            let ext = match media.extension().and_then(|e| e.to_str()) {
                Some(e) => e.to_lowercase(),
                None => continue,
            };
            let is_heic = HEIC_EXTENSIONS.contains(&ext.as_str());
            if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
                summary.videos_skipped += 1;
                continue;
            }
            if !IMAGE_EXTENSIONS.contains(&ext.as_str()) && !is_heic {
                continue;
            }
            let file_name = media
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();

            // Skip Takeout's "-edited" renditions; the original is imported
            if media
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.ends_with("-edited"))
            {
                summary.edited_skipped += 1;
                continue;
            }

            summary.scanned += 1;

            match import_one(pool, photo_store, media, &file_name, &sidecars, is_heic).await {
                Ok(ImportOutcome::Imported) => summary.imported += 1,
                Ok(ImportOutcome::Duplicate) => summary.duplicates += 1,
                Ok(ImportOutcome::NoSidecar) => {
                    summary.no_sidecar += 1;
                    summary.imported += 1; // still imported, via EXIF fallback
                }
                Err(e) => {
                    warn!(file = %media.display(), error = %e, "Failed to import photo");
                    summary.failed += 1;
                }
            }

            if let Some(n) = limit {
                if summary.imported + summary.duplicates >= n {
                    info!(limit = n, "Import limit reached");
                    break 'outer;
                }
            }
        }
    }

    info!(
        imported = summary.imported,
        duplicates = summary.duplicates,
        failed = summary.failed,
        "Takeout import complete"
    );
    Ok(summary)
}

enum ImportOutcome {
    Imported,
    Duplicate,
    NoSidecar,
}

async fn import_one(
    pool: &PgPool,
    photo_store: &Path,
    media: &Path,
    file_name: &str,
    sidecars: &HashMap<String, PhotoMeta>,
    is_heic: bool,
) -> Result<ImportOutcome> {
    let bytes = std::fs::read(media)?;
    let sha256 = hex::encode(Sha256::digest(&bytes));

    let exists: Option<(uuid::Uuid,)> = sqlx::query_as("SELECT id FROM photos WHERE sha256 = $1")
        .bind(&sha256)
        .fetch_optional(pool)
        .await?;
    if exists.is_some() {
        debug!(file = %file_name, "Duplicate photo (sha256), skipping");
        return Ok(ImportOutcome::Duplicate);
    }

    // Sidecar lookup: exact name, then the reconstructed duplicate key. Takeout
    // names a duplicate's media `IMG(1).jpg` but its sidecar `IMG.jpg(1).json`
    // (the marker moves *after* the extension), which media_name_from_sidecar
    // keyed as `IMG.jpg(1)`. Previously we stripped the marker to `IMG.jpg` and
    // grabbed the *original* photo's sidecar — importing the wrong time and GPS.
    let sidecar = sidecars
        .get(file_name)
        .or_else(|| dup_sidecar_key(file_name).and_then(|k| sidecars.get(&k)))
        .cloned();
    let had_sidecar = sidecar.is_some();

    // EXIF fallback (and refinement: EXIF GPS is often more precise)
    let exif_meta = read_exif_meta(&bytes);
    let meta = match sidecar {
        Some(mut m) => {
            if m.lat_lon.is_none() {
                m.lat_lon = exif_meta.lat_lon;
            }
            m
        }
        None => exif_meta,
    };

    // Decode (HEIC via sips on macOS) and generate renditions
    let decoded = decode_image(&bytes, media, is_heic)?;
    let oriented = apply_exif_orientation(decoded, &bytes);
    // Record dimensions AFTER orientation, or portrait photos (EXIF orientation
    // 5–8, which swap width/height) store transposed dimensions.
    let (width, height) = (oriented.width(), oriented.height());

    let thumb_path = photo_store.join(format!("{sha256}_thumb.jpg"));
    let medium_path = photo_store.join(format!("{sha256}_medium.jpg"));
    save_jpeg(&oriented.thumbnail(THUMB_PX, THUMB_PX), &thumb_path)?;
    save_jpeg(&oriented.thumbnail(MEDIUM_PX, MEDIUM_PX), &medium_path)?;

    sqlx::query(
        r#"
        INSERT INTO photos (id, sha256, source, original_filename, google_photos_url,
                            taken_at, location, thumbnail_path, medium_path, width, height)
        VALUES ($1, $2, 'takeout', $3, $4, $5,
                CASE WHEN $6::float8 IS NOT NULL
                     THEN ST_SetSRID(ST_MakePoint($7, $6), 4326) END,
                $8, $9, $10, $11)
        "#,
    )
    .bind(PhotoId::new().0)
    .bind(&sha256)
    .bind(file_name)
    .bind(&meta.url)
    .bind(meta.taken_at)
    .bind(meta.lat_lon.map(|(lat, _)| lat))
    .bind(meta.lat_lon.map(|(_, lon)| lon))
    .bind(thumb_path.to_string_lossy())
    .bind(medium_path.to_string_lossy())
    .bind(width as i32)
    .bind(height as i32)
    .execute(pool)
    .await?;

    if had_sidecar {
        Ok(ImportOutcome::Imported)
    } else {
        Ok(ImportOutcome::NoSidecar)
    }
}

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| exts.contains(&e.to_lowercase().as_str()))
}

/// Derive the media filename a sidecar refers to from the sidecar's own name.
/// `IMG.jpg.json` → `IMG.jpg`; `IMG.jpg.supplemental-metadata.json` → `IMG.jpg`;
/// `IMG.jpg(1).json` → `IMG(1).jpg` is NOT reconstructed — we key it as
/// `IMG.jpg(1)` and rely on `strip_dup_marker` at lookup time.
fn media_name_from_sidecar(sidecar: &Path) -> Option<String> {
    let name = sidecar.file_name()?.to_str()?;
    let without_json = name.strip_suffix(".json")?;
    // Drop a `.supplemental-metadata` style infix (possibly truncated by
    // Takeout's filename length cap) if present after the media extension.
    if let Some(idx) = without_json.to_lowercase().find(".suppl") {
        return Some(without_json[..idx].to_string());
    }
    Some(without_json.to_string())
}

/// Reconstruct the sidecar key for a Takeout duplicate: the media file
/// `IMG_123(1).jpg` is described by `IMG_123.jpg(1).json`, which
/// `media_name_from_sidecar` keys as `IMG_123.jpg(1)`. Returns `None` when the
/// name carries no `(N)` duplicate marker (so callers don't fall back to the
/// original photo's sidecar).
fn dup_sidecar_key(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    let open = stem.rfind('(')?;
    if stem.ends_with(')') && stem[open + 1..stem.len() - 1].chars().all(|c| c.is_ascii_digit()) {
        let marker = &stem[open..]; // "(1)"
        let base = &stem[..open]; // "IMG_123"
        Some(format!("{base}.{ext}{marker}"))
    } else {
        None
    }
}

/// Read taken-at + GPS from EXIF (used when no sidecar exists, or when the
/// sidecar carries no location).
fn read_exif_meta(bytes: &[u8]) -> PhotoMeta {
    let mut cursor = std::io::Cursor::new(bytes);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut cursor) else {
        return PhotoMeta::default();
    };

    let coord = |value_tag: exif::Tag, ref_tag: exif::Tag| -> Option<f64> {
        let field = exif.get_field(value_tag, exif::In::PRIMARY)?;
        let exif::Value::Rational(parts) = &field.value else {
            return None;
        };
        if parts.len() < 3 {
            return None;
        }
        let deg = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
        let reference = exif
            .get_field(ref_tag, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .unwrap_or_default();
        Some(if reference.contains('S') || reference.contains('W') {
            -deg
        } else {
            deg
        })
    };

    let lat = coord(exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef);
    let lon = coord(exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef);

    // DateTimeOriginal is local wall-clock with no zone. Convert to UTC using the
    // GPS longitude as an offset estimate (15° per hour), falling back to the
    // home timezone (AEST, +10) when the photo has no GPS. Storing it verbatim as
    // UTC (the old behaviour) shifted no-sidecar photos by the whole tz offset —
    // enough to miss the ±30 min ride-matching window entirely.
    const HOME_OFFSET_SECS: i64 = 10 * 3600;
    let offset_secs = lon
        .map(|l| (l / 15.0 * 3600.0) as i64)
        .unwrap_or(HOME_OFFSET_SECS);
    let taken_at = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string())
        .and_then(|s| {
            chrono::NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(&s, "%Y:%m:%d %H:%M:%S"))
                .ok()
        })
        .map(|naive| (naive - chrono::Duration::seconds(offset_secs)).and_utc());

    PhotoMeta {
        taken_at,
        lat_lon: lat.zip(lon),
        url: None,
    }
}

/// Decode image bytes; HEIC is converted via macOS `sips` first.
fn decode_image(bytes: &[u8], path: &Path, is_heic: bool) -> Result<image::DynamicImage> {
    if is_heic {
        return decode_heic_via_sips(path);
    }
    image::load_from_memory(bytes)
        .map_err(|e| dingo_core::Error::Other(format!("image decode failed: {e}")))
}

fn decode_heic_via_sips(path: &Path) -> Result<image::DynamicImage> {
    if !cfg!(target_os = "macos") {
        return Err(dingo_core::Error::Other(
            "HEIC decoding requires macOS (sips)".to_string(),
        ));
    }
    let tmp = std::env::temp_dir().join(format!("dingo_heic_{}.jpg", uuid::Uuid::new_v4()));
    let status = std::process::Command::new("sips")
        .args(["-s", "format", "jpeg"])
        .arg(path)
        .arg("--out")
        .arg(&tmp)
        .output()?;
    if !status.status.success() {
        return Err(dingo_core::Error::Other(format!(
            "sips HEIC conversion failed: {}",
            String::from_utf8_lossy(&status.stderr)
        )));
    }
    let bytes = std::fs::read(&tmp)?;
    let _ = std::fs::remove_file(&tmp);
    image::load_from_memory(&bytes)
        .map_err(|e| dingo_core::Error::Other(format!("image decode failed: {e}")))
}

/// Apply EXIF orientation so thumbnails aren't sideways/upside-down.
fn apply_exif_orientation(img: image::DynamicImage, bytes: &[u8]) -> image::DynamicImage {
    let mut cursor = std::io::Cursor::new(bytes);
    let orientation = exif::Reader::new()
        .read_from_container(&mut cursor)
        .ok()
        .and_then(|e| {
            e.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
        })
        .unwrap_or(1);

    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn save_jpeg(img: &image::DynamicImage, path: &Path) -> Result<()> {
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let file = std::fs::File::create(path)?;
    let mut writer = std::io::BufWriter::new(file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
    rgb.write_with_encoder(encoder)
        .map_err(|e| dingo_core::Error::Other(format!("jpeg encode failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dup_sidecar_key_reconstruction() {
        // The `(N)` marker moves to after the extension to match Takeout's
        // sidecar naming (IMG_123(1).jpg → IMG_123.jpg(1).json → key IMG_123.jpg(1)).
        assert_eq!(dup_sidecar_key("IMG_123(1).jpg").as_deref(), Some("IMG_123.jpg(1)"));
        // No duplicate marker → None, so we never fall back to the original's sidecar.
        assert_eq!(dup_sidecar_key("IMG_123.jpg"), None);
        assert_eq!(dup_sidecar_key("IMG(a).jpg"), None);
    }

    #[test]
    fn sidecar_name_derivation() {
        assert_eq!(
            media_name_from_sidecar(Path::new("IMG.jpg.json")),
            Some("IMG.jpg".to_string())
        );
        assert_eq!(
            media_name_from_sidecar(Path::new("IMG.jpg.supplemental-metadata.json")),
            Some("IMG.jpg".to_string())
        );
        assert_eq!(
            media_name_from_sidecar(Path::new("IMG.jpg.supplemental-metad.json")),
            Some("IMG.jpg".to_string())
        );
        assert_eq!(media_name_from_sidecar(Path::new("IMG.jpg")), None);
    }

    #[test]
    fn sidecar_meta_parsing() {
        let json = r#"{
            "title": "IMG_1.jpg",
            "photoTakenTime": {"timestamp": "1704104010"},
            "geoData": {"latitude": -33.5, "longitude": 151.1},
            "url": "https://photos.google.com/photo/abc"
        }"#;
        let sc: Sidecar = serde_json::from_str(json).unwrap();
        let meta = sc.into_meta();
        assert_eq!(meta.lat_lon, Some((-33.5, 151.1)));
        assert_eq!(meta.url.as_deref(), Some("https://photos.google.com/photo/abc"));
        assert_eq!(meta.taken_at.unwrap().timestamp(), 1704104010);
    }

    #[test]
    fn zero_geo_is_none() {
        let json = r#"{
            "title": "IMG_2.jpg",
            "photoTakenTime": {"timestamp": "1704104010"},
            "geoData": {"latitude": 0.0, "longitude": 0.0}
        }"#;
        let sc: Sidecar = serde_json::from_str(json).unwrap();
        assert_eq!(sc.into_meta().lat_lon, None);
    }
}
