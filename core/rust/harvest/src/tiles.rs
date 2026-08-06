//! Web-mercator XYZ tile math (same scheme as the export bundler's
//! `corridor_tiles`, factored for the harvester's descent).

/// Web-mercator latitude limit — beyond this there are no tiles.
pub const MAX_LAT: f64 = 85.051_128_779_806_59;

/// Tile coordinate of the tile containing a lon/lat at zoom `z`.
pub fn lonlat_to_tile(lon: f64, lat: f64, z: u32) -> (u32, u32) {
    let n = 1u64 << z;
    let clamp = |v: i64| v.clamp(0, n as i64 - 1) as u32;
    let x = ((lon + 180.0) / 360.0 * n as f64).floor() as i64;
    let r = lat.clamp(-MAX_LAT, MAX_LAT).to_radians();
    let y = ((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0 * n as f64)
        .floor() as i64;
    (clamp(x), clamp(y))
}

/// Geographic bounds `[west, south, east, north]` of a tile.
pub fn tile_bounds(z: u32, x: u32, y: u32) -> [f64; 4] {
    let n = (1u64 << z) as f64;
    let lon = |x: f64| x / n * 360.0 - 180.0;
    let lat = |y: f64| {
        let t = std::f64::consts::PI * (1.0 - 2.0 * y / n);
        t.sinh().atan().to_degrees()
    };
    [lon(x as f64), lat((y + 1) as f64), lon((x + 1) as f64), lat(y as f64)]
}

/// The four children of a tile at the next zoom level.
pub fn children(z: u32, x: u32, y: u32) -> [(u32, u32, u32); 4] {
    let (z, x, y) = (z + 1, x * 2, y * 2);
    [(z, x, y), (z, x + 1, y), (z, x, y + 1), (z, x + 1, y + 1)]
}

/// All tiles at zoom `z` intersecting a `[west, south, east, north]` bbox.
pub fn cover_bbox(bbox: [f64; 4], z: u32) -> Vec<(u32, u32, u32)> {
    let [w, s, e, n] = bbox;
    let (x0, y0) = lonlat_to_tile(w, n, z); // north edge → smaller y
    let (x1, y1) = lonlat_to_tile(e, s, z);
    let mut tiles = Vec::with_capacity(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize);
    for x in x0..=x1 {
        for y in y0..=y1 {
            tiles.push((z, x, y));
        }
    }
    tiles
}

/// Do two `[west, south, east, north]` boxes overlap?
pub fn bbox_intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quadrants_at_z1() {
        assert_eq!(lonlat_to_tile(-90.0, 45.0, 1), (0, 0));
        assert_eq!(lonlat_to_tile(90.0, 45.0, 1), (1, 0));
        assert_eq!(lonlat_to_tile(-90.0, -45.0, 1), (0, 1));
        assert_eq!(lonlat_to_tile(90.0, -45.0, 1), (1, 1));
    }

    #[test]
    fn sydney_z10() {
        // Sydney CBD ≈ 151.21E, 33.87S — the well-known slippy tile.
        assert_eq!(lonlat_to_tile(151.21, -33.87, 10), (942, 614));
    }

    #[test]
    fn bounds_roundtrip() {
        let (z, x, y) = (10, 942, 614);
        let [w, s, e, n] = tile_bounds(z, x, y);
        assert!(w < 151.21 && 151.21 < e);
        assert!(s < -33.87 && -33.87 < n);
        // Centre of the bounds maps back to the same tile.
        assert_eq!(lonlat_to_tile((w + e) / 2.0, (s + n) / 2.0, z), (x, y));
    }

    #[test]
    fn children_tile_the_parent() {
        let parent = tile_bounds(5, 10, 20);
        for (z, x, y) in children(5, 10, 20) {
            let c = tile_bounds(z, x, y);
            assert!(bbox_intersects(parent, c));
            assert!(c[0] >= parent[0] - 1e-9 && c[2] <= parent[2] + 1e-9);
            assert!(c[1] >= parent[1] - 1e-9 && c[3] <= parent[3] + 1e-9);
        }
    }

    #[test]
    fn cover_small_bbox() {
        // A bbox inside a single z6 tile covers exactly one tile.
        let tiles = cover_bbox([151.0, -33.6, 151.3, -33.3], 6);
        assert_eq!(tiles.len(), 1);
        // At z13 it covers a proper grid, all within the bbox neighbourhood.
        let deep = cover_bbox([151.0, -33.6, 151.3, -33.3], 13);
        assert!(deep.len() > 20);
        for &(z, x, y) in &deep {
            assert!(bbox_intersects(tile_bounds(z, x, y), [151.0, -33.6, 151.3, -33.3]));
        }
    }
}
