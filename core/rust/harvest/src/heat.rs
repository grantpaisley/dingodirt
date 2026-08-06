//! Heat measurement — the descent/prune signal.
//!
//! Strava's grayscale intensity tiles encode "no rides here" as fully
//! transparent or black pixels, so the fraction of pixels that are both
//! visible and non-black is a trivial, honest heat metric.

use anyhow::Context;

/// Fraction of pixels carrying heat (visible and non-black), in `[0, 1]`.
pub fn heat_ratio(png: &[u8]) -> anyhow::Result<f64> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .context("decode tile PNG")?;
    let la = img.to_luma_alpha8();
    let total = la.pixels().len();
    if total == 0 {
        return Ok(0.0);
    }
    let hot = la
        .pixels()
        .filter(|p| p.0[0] > 0 && p.0[1] > 0) // luma > 0 and alpha > 0
        .count();
    Ok(hot as f64 / total as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, LumaA};

    fn encode(img: image::ImageBuffer<LumaA<u8>, Vec<u8>>) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageLumaA8(img).write_to(&mut buf, ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn transparent_tile_is_empty() {
        let img = image::ImageBuffer::from_pixel(64, 64, LumaA([0u8, 0u8]));
        assert_eq!(heat_ratio(&encode(img)).unwrap(), 0.0);
    }

    #[test]
    fn opaque_black_is_empty() {
        let img = image::ImageBuffer::from_pixel(64, 64, LumaA([0u8, 255u8]));
        assert_eq!(heat_ratio(&encode(img)).unwrap(), 0.0);
    }

    #[test]
    fn quarter_hot() {
        let img = image::ImageBuffer::from_fn(64, 64, |x, y| {
            if x < 32 && y < 32 { LumaA([200u8, 255u8]) } else { LumaA([0u8, 0u8]) }
        });
        let r = heat_ratio(&encode(img)).unwrap();
        assert!((r - 0.25).abs() < 1e-9, "ratio {r}");
    }

    #[test]
    fn garbage_errors() {
        assert!(heat_ratio(b"not a png").is_err());
    }
}
