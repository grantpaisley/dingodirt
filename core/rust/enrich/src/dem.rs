//! Terrarium DEM sampler — elevation for any lat/lon from the AWS Open Data
//! terrain tiles (the same free source make_hillshade.py cuts Nav's relief
//! from; SRTM / Geoscience Australia et al., no API key).
//!
//! Tiles are 256×256 PNGs, elevation packed per pixel as
//! `(R*256 + G + B/256) − 32768` metres. One tile at z13 covers ~4.9 km at
//! these latitudes (~19 m/px), which is finer than the GPS tracks it fills.
//! Fetched tiles are cached for the life of the client, so a whole ride
//! usually costs a handful of requests.

use std::collections::HashMap;

use dingo_core::{Error, Result};

const TILE_URL: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const ZOOM: u8 = 13;
const TILE_PX: u32 = 256;

pub struct DemClient {
    http: reqwest::Client,
    /// (x, y) → decoded tile; None caches a fetch/decode failure so a dead
    /// tile is not re-requested for every point that lands on it
    cache: HashMap<(u32, u32), Option<image::RgbImage>>,
}

impl DemClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            cache: HashMap::new(),
        }
    }

    /// Slippy-map maths: lat/lon → (tile x, tile y, pixel x, pixel y) at ZOOM.
    fn locate(lat: f64, lon: f64) -> (u32, u32, u32, u32) {
        let n = (1u32 << ZOOM) as f64;
        let xf = (lon + 180.0) / 360.0 * n;
        let lat_rad = lat.to_radians();
        let yf = (1.0 - lat_rad.tan().asinh() / std::f64::consts::PI) / 2.0 * n;
        let clamp = |v: f64| v.max(0.0).min(n - 1e-9);
        let (xf, yf) = (clamp(xf), clamp(yf));
        let (tx, ty) = (xf as u32, yf as u32);
        let px = ((xf - tx as f64) * TILE_PX as f64) as u32;
        let py = ((yf - ty as f64) * TILE_PX as f64) as u32;
        (tx, ty, px.min(TILE_PX - 1), py.min(TILE_PX - 1))
    }

    async fn tile(&mut self, x: u32, y: u32) -> Result<Option<&image::RgbImage>> {
        if !self.cache.contains_key(&(x, y)) {
            let url = format!("{TILE_URL}/{ZOOM}/{x}/{y}.png");
            let decoded = match self.http.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                    Ok(bytes) => image::load_from_memory(&bytes)
                        .map(|img| img.to_rgb8())
                        .map_err(|e| tracing::warn!(url, error = %e, "DEM tile decode failed"))
                        .ok(),
                    Err(e) => {
                        tracing::warn!(url, error = %e, "DEM tile body failed");
                        None
                    }
                },
                Ok(resp) => {
                    tracing::warn!(url, status = %resp.status(), "DEM tile fetch failed");
                    None
                }
                Err(e) => {
                    // network trouble is likely to hit every tile — surface it
                    return Err(Error::Other(format!("DEM fetch {url}: {e}")));
                }
            };
            self.cache.insert((x, y), decoded);
        }
        Ok(self.cache.get(&(x, y)).and_then(|t| t.as_ref()))
    }

    /// Elevation in metres at a point, or None where the tile is unavailable.
    pub async fn elevation(&mut self, lat: f64, lon: f64) -> Result<Option<f64>> {
        if !(-85.0..=85.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            return Ok(None);
        }
        let (tx, ty, px, py) = Self::locate(lat, lon);
        let Some(tile) = self.tile(tx, ty).await? else { return Ok(None) };
        let p = tile.get_pixel(px, py);
        let h = (p[0] as f64) * 256.0 + (p[1] as f64) + (p[2] as f64) / 256.0 - 32768.0;
        // terrarium nodata decodes to absurd depths — treat anything below the
        // Dead Sea as missing rather than writing garbage into a track
        Ok((h > -500.0).then_some((h * 10.0).round() / 10.0))
    }
}

impl Default for DemClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_maps_sydney_into_the_right_tile() {
        // Sydney CBD ≈ -33.87, 151.21 → z13 tile (7536, 4915) give or take one
        let (tx, ty, px, py) = DemClient::locate(-33.87, 151.21);
        assert!((7530..7545).contains(&tx), "tx = {tx}");
        assert!((4910..4925).contains(&ty), "ty = {ty}");
        assert!(px < 256 && py < 256);
    }

    #[test]
    fn locate_clamps_poles() {
        let (_, ty, _, py) = DemClient::locate(89.9, 0.0);
        assert_eq!(ty, 0);
        assert!(py < 256);
    }
}
