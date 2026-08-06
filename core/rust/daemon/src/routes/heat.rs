//! Heat archive serve route (harvester phase 2).
//!
//! Reads pre-harvested grayscale heat tiles straight from the owner's MBTiles
//! archives (`<file_store>/heat/<owner_slug>-*.mbtiles`) — one indexed SQLite
//! lookup, no Strava contact, no cookies. The web map colours the grayscale
//! client-side with MapLibre `raster-color` (blue for "everyone else").
//!
//! This replaces the live `strava-heatmap` cookie proxy: the harvester acquires
//! tiles once and we serve them locally forever.

use axum::{
    Router,
    body::Body,
    extract::Path,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use sqlx::PgPool;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tracing::{info, warn};
use uuid::Uuid;

/// One-at-a-time guard so overlapping imports don't double-fetch the same
/// frontier (the worker takes no row locks on `next_pending`). A drain already
/// running will pick up whatever a concurrent import just queued.
static IMPORT_HARVEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The region every import's corridor accumulates into.
const IMPORT_REGION: &str = "auto-import-corridor";

pub fn routes() -> Router {
    Router::new().route("/{owner}/{z}/{x}/{y}", get(get_tile))
}

/// `GET /api/heat/{owner}/{z}/{x}/{y}.png` — one grayscale heat tile for an
/// owner (e.g. `strava-global`), or 404 when that tile isn't in the archive.
async fn get_tile(Path((owner, z, x, y_raw)): Path<(String, u32, u32, String)>) -> Response {
    // Owner comes from the URL — clamp to the slug charset so it can only ever
    // name a file in the heat dir, never escape it.
    if owner.is_empty() || !owner.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return (StatusCode::BAD_REQUEST, "bad owner").into_response();
    }
    let y_str = y_raw.strip_suffix(".png").unwrap_or(&y_raw);
    let y: u32 = match y_str.parse() {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad tile y").into_response(),
    };
    if z > 20 {
        return (StatusCode::BAD_REQUEST, "zoom out of range").into_response();
    }
    // x,y must be in range for the zoom — otherwise the TMS flip
    // `(1<<z)-1-y` underflows (debug panic / release wrap) (audit low).
    let dim = 1u32 << z;
    if x >= dim || y >= dim {
        return (StatusCode::BAD_REQUEST, "tile x/y out of range").into_response();
    }

    // MBTiles read + colourisation are blocking (SQLite I/O + PNG codec) — keep
    // them off the async runtime.
    let result = tokio::task::spawn_blocking(move || {
        match dingo_harvest::worker::read_owner_tile(&owner, z, x, y) {
            Ok(Some(gray)) => colourise(&gray, &owner).map(Some),
            Ok(None) => Ok(None),
            Err(e) => Err(e),
        }
    })
    .await;

    match result {
        Ok(Ok(Some(bytes))) => png(bytes),
        // No such tile: empty/unharvested. 404 is what MapLibre treats as "skip".
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, "no tile").into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("join: {e}")).into_response(),
    }
}

/// Colourise a grayscale intensity tile into an RGBA heat ramp, per owner:
/// hikes (`strava-hike`) render purple, everything else (rides) blue. We store
/// grayscale (the substrate) and colour here at serve time because MapLibre GL
/// JS has no `raster-color` paint property.
pub(crate) fn colourise(gray_png: &[u8], owner: &str) -> anyhow::Result<Vec<u8>> {
    use image::{ImageEncoder, ImageFormat};
    let stops = ramp_stops(owner);
    let img = image::load_from_memory_with_format(gray_png, ImageFormat::Png)?.to_luma8();
    let (w, h) = img.dimensions();
    let mut out = image::RgbaImage::new(w, h);
    for (px, py, p) in img.enumerate_pixels() {
        out.put_pixel(px, py, ramp(p.0[0], stops));
    }
    let mut buf = Vec::new();
    image::codecs::png::PngEncoder::new(&mut buf).write_image(
        &out,
        w,
        h,
        image::ExtendedColorType::Rgba8,
    )?;
    Ok(buf)
}

/// Heat colour ramp (intensity stops → RGBA) for an owner: `strava-hike` gets a
/// purple ramp so hikes read distinctly from the blue ride heat; everything
/// else stays blue.
fn ramp_stops(owner: &str) -> &'static [(f32, [f32; 4])] {
    // Dark → bright, matched lightness so the two hues read at the same weight.
    // Alpha follows the curve Strava's own colourised tiles use (measured off
    // their palette PNGs, 2026-07-28 zoom-parity bench): no low cutoff — even
    // intensity 1 shows at ~1/3 opacity, exactly like once-ridden roads on
    // strava.com — then a sub-linear rise to near-opaque. Hues stay Dingo's.
    const BLUE: [(f32, [f32; 4]); 4] = [
        (0.003, [20.0, 50.0, 140.0, 84.0]),
        (0.11, [26.0, 85.0, 195.0, 176.0]),
        (0.45, [30.0, 110.0, 230.0, 210.0]),
        (1.0, [120.0, 200.0, 255.0, 252.0]),
    ];
    const PURPLE: [(f32, [f32; 4]); 4] = [
        (0.003, [80.0, 25.0, 130.0, 84.0]),
        (0.11, [120.0, 45.0, 180.0, 176.0]),
        (0.45, [150.0, 55.0, 220.0, 210.0]),
        (1.0, [210.0, 150.0, 255.0, 252.0]),
    ];
    if owner.contains("hike") {
        &PURPLE
    } else {
        &BLUE
    }
}

/// Grayscale intensity (0..255) → heat RGBA along `stops`. Low intensity fades
/// to transparent so the basemap shows; high intensity is the bright end.
fn ramp(v: u8, stops: &[(f32, [f32; 4])]) -> image::Rgba<u8> {
    let t = v as f32 / 255.0;
    // Below the first stop, treat as no activity → fully transparent.
    if t < stops[0].0 {
        return image::Rgba([0, 0, 0, 0]);
    }
    let mut lo = stops[0];
    let mut hi = stops[stops.len() - 1];
    for w in stops.windows(2) {
        if t >= w[0].0 && t <= w[1].0 {
            lo = w[0];
            hi = w[1];
            break;
        }
    }
    let span = (hi.0 - lo.0).max(1e-6);
    let f = ((t - lo.0) / span).clamp(0.0, 1.0);
    let c = |i: usize| (lo.1[i] + (hi.1[i] - lo.1[i]) * f).round() as u8;
    image::Rgba([c(0), c(1), c(2), c(3)])
}

/// Queue the Strava heat corridor for freshly-imported rides and, if the daemon
/// currently holds valid Strava cookies, drain it in the background. Cookieless
/// or expired: the tiles stay queued for the next `dingo-harvest run
/// auto-import-corridor` (or a cookie refresh). Best-effort — logs and returns.
/// Spawn this AFTER `clean_all_rides` so `cleaned_geometry` (the corridor source)
/// is populated.
pub async fn auto_harvest_import(pool: PgPool, ride_ids: Vec<Uuid>) {
    use dingo_harvest::{frontier, worker};
    let owner = match frontier::strava_owner(&pool).await {
        Ok(o) => o,
        Err(e) => {
            warn!(error = %e, "auto-harvest: no Strava owner; skipping");
            return;
        }
    };
    // z14 + z15 corridor, dilated by one tile, following the imported tracks.
    let (region, seeded) =
        match frontier::seed_rides_corridor(&pool, owner, IMPORT_REGION, &ride_ids, 14, 15, 1, 0.004)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "auto-harvest: seeding import corridor failed");
                return;
            }
        };
    info!(
        rides = ride_ids.len(),
        seeded,
        region = %region.name,
        "auto-harvest: queued Strava heat corridor for import"
    );
    if seeded == 0 {
        return;
    }
    // One drain at a time; a running drain absorbs the newly-queued tiles.
    let _guard = match IMPORT_HARVEST_LOCK.try_lock() {
        Ok(g) => g,
        Err(_) => {
            info!("auto-harvest: a drain is already running; new tiles queued for it");
            return;
        }
    };
    let opts = worker::RunOpts {
        rate: 2.0,
        jitter: 0.3,
        window: None,
        limit: None,
        min_heat_ratio: 0.0,
    };
    match worker::run_with_stop(&pool, &region.name, opts, Arc::new(AtomicBool::new(false))).await {
        Ok(s) => info!(
            fetched = s.fetched,
            stored = s.stored,
            "auto-harvest: import corridor drained"
        ),
        Err(e) => warn!(
            error = %e,
            "auto-harvest: cannot fetch now (no/expired Strava cookies?) — corridor stays queued"
        ),
    }
}

fn png(bytes: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        Body::from(bytes),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ramp follows Strava's own alpha curve (2026-07-28 zoom-parity
    /// bench): no low cutoff — the faintest once-ridden heat stays visible —
    /// and a sub-linear rise to near-opaque at full intensity.
    #[test]
    fn faintest_heat_is_visible_not_cut() {
        let stops = ramp_stops("strava-ride");
        let faint = ramp(1, stops);
        assert!(faint.0[3] >= 80, "intensity 1 should show at ~1/3 opacity, got alpha {}", faint.0[3]);
        let zero = ramp(0, stops);
        assert_eq!(zero.0[3], 0, "true zero stays transparent");
        let full = ramp(255, stops);
        assert!(full.0[3] >= 250, "full intensity near-opaque");
        // sub-linear: 11% intensity already carries most of the opacity
        let low = ramp(28, stops);
        assert!(low.0[3] >= 170, "alpha rise must be sub-linear like Strava's, got {}", low.0[3]);
    }

    #[test]
    fn hike_ramp_is_distinct_hue() {
        let ride = ramp(128, ramp_stops("strava-ride"));
        let hike = ramp(128, ramp_stops("strava-hike"));
        assert_ne!(ride.0, hike.0);
    }
}
