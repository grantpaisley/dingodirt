//! Route color assignment for planned-route collections
//!
//! Curated route files usually arrive with no color information (GPS
//! Visualizer strips extensions), so we assign each route a distinct, stable
//! color within its collection: routes are sorted by name and hues rotate by
//! the golden angle, so adjacent list entries land far apart on the wheel
//! and re-importing the same file reproduces the same colors.

/// Golden angle in degrees — successive hues never cluster.
const GOLDEN_ANGLE: f64 = 137.507_764;

/// Saturation/lightness tuned to read against the dark map style without
/// fighting the heat layers.
const SATURATION: f64 = 0.75;
const LIGHTNESS: f64 = 0.55;

/// Color for the route at `index` within a collection (0-based, ordered by
/// track name). Returns `#rrggbb`.
pub fn palette_color(index: usize) -> String {
    let hue = (index as f64 * GOLDEN_ANGLE) % 360.0;
    let (r, g, b) = hsl_to_rgb(hue, SATURATION, LIGHTNESS);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Assign colors to a collection's tracks by name. Tracks that already have
/// a color (parsed from GPX extensions) keep it; the rest get palette hues
/// by their position in the name-sorted order. Returns colors in the same
/// order as the input slice.
pub fn assign_colors(names_and_colors: &[(String, Option<String>)]) -> Vec<String> {
    let mut order: Vec<usize> = (0..names_and_colors.len()).collect();
    order.sort_by(|&a, &b| names_and_colors[a].0.cmp(&names_and_colors[b].0));

    let mut result = vec![String::new(); names_and_colors.len()];
    for (sorted_pos, &orig_idx) in order.iter().enumerate() {
        result[orig_idx] = match &names_and_colors[orig_idx].1 {
            Some(color) => color.clone(),
            None => palette_color(sorted_pos),
        };
    }
    result
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    (
        ((r1 + m) * 255.0).round() as u8,
        ((g1 + m) * 255.0).round() as u8,
        ((b1 + m) * 255.0).round() as u8,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_are_stable_and_distinct() {
        let a = palette_color(0);
        let b = palette_color(1);
        assert_eq!(a, palette_color(0));
        assert_ne!(a, b);
        // 40 routes (the largest GOAT file has 91) stay pairwise distinct
        let colors: Vec<String> = (0..91).map(palette_color).collect();
        let unique: std::collections::HashSet<&String> = colors.iter().collect();
        assert_eq!(unique.len(), colors.len());
    }

    #[test]
    fn valid_hex_format() {
        for i in 0..20 {
            let c = palette_color(i);
            assert_eq!(c.len(), 7);
            assert!(c.starts_with('#'));
            assert!(u32::from_str_radix(&c[1..], 16).is_ok());
        }
    }

    #[test]
    fn assignment_is_order_independent() {
        let forward = vec![
            ("Alpha".to_string(), None),
            ("Bravo".to_string(), None),
            ("Charlie".to_string(), None),
        ];
        let shuffled = vec![
            ("Charlie".to_string(), None),
            ("Alpha".to_string(), None),
            ("Bravo".to_string(), None),
        ];
        let f = assign_colors(&forward);
        let s = assign_colors(&shuffled);
        assert_eq!(f[0], s[1]); // Alpha keeps its color wherever it appears
        assert_eq!(f[1], s[2]);
        assert_eq!(f[2], s[0]);
    }

    #[test]
    fn existing_colors_are_kept() {
        let input = vec![
            ("Alpha".to_string(), Some("#ff0000".to_string())),
            ("Bravo".to_string(), None),
        ];
        let out = assign_colors(&input);
        assert_eq!(out[0], "#ff0000");
        assert_ne!(out[1], "#ff0000");
    }
}
