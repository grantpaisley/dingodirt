//! Ride mode classification.
//!
//! FIT sport/sub_sport metadata is the primary signal; speed-signature
//! heuristics handle the ambiguous cases:
//! - `generic/track_me` recordings are mostly dirt-bike rides but can be
//!   hikes or ebike rides.
//! - `cycling/e_bike_*` profiles are used for BOTH electric motorbike enduro
//!   and real eMTB riding. The 25 km/h pedal-assist cap separates them: an
//!   eMTB rarely sustains speeds above the cap (short downhill bursts only),
//!   while an electric motorbike does.

use crate::cleaning::CleanedTimeSeriesPoint;

/// Sustained-speed thresholds (km/h). Tunable — see `dingo mode reclassify`
/// output for the resulting distribution.
const HIKING_MAX_AVG_KMH: f64 = 7.0;
/// Moving average above this can't be pedal-assist-capped ebike or foot travel.
const MOTO_AVG_MOVING_KMH: f64 = 22.0;
/// 95th-percentile speed above this indicates motor power (p95 rather than raw
/// max so single GPS spikes or one long descent don't flip the class).
const MOTO_P95_KMH: f64 = 50.0;
/// ADV = long full-day rides; enduro = shorter technical loops.
const ADV_DISTANCE_KM: f64 = 80.0;
const ADV_FAST_AVG_KMH: f64 = 40.0;
const ADV_FAST_DISTANCE_KM: f64 = 40.0;
/// Sustained speed no ground vehicle of ours reaches — jets and light
/// aircraft cruise 180-300+ km/h. Uses p95 so GPS spikes don't trigger it.
const AIRCRAFT_P95_KMH: f64 = 170.0;

/// Speed/distance summary of a ride used for classification.
#[derive(Debug, Clone, Copy, Default)]
pub struct RideStats {
    /// Mean speed over non-stopped points (km/h)
    pub avg_moving_speed_kmh: f64,
    /// 95th percentile of point speeds (km/h)
    pub p95_speed_kmh: f64,
    pub distance_km: f64,
}

impl RideStats {
    pub fn from_time_series(time_series: &[CleanedTimeSeriesPoint]) -> Self {
        let mut moving_speeds: Vec<f64> = Vec::with_capacity(time_series.len());
        let mut all_speeds: Vec<f64> = Vec::with_capacity(time_series.len());
        let mut distance_m = 0.0f64;

        for point in time_series {
            if let Some(speed) = point.speed_ms {
                all_speeds.push(speed);
                if !point.is_stopped {
                    moving_speeds.push(speed);
                }
            }
            distance_m = point.distance_cumulative_m;
        }

        let avg_moving_ms = if moving_speeds.is_empty() {
            0.0
        } else {
            moving_speeds.iter().sum::<f64>() / moving_speeds.len() as f64
        };

        let p95_ms = if all_speeds.is_empty() {
            0.0
        } else {
            all_speeds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            all_speeds[((all_speeds.len() - 1) as f64 * 0.95) as usize]
        };

        RideStats {
            avg_moving_speed_kmh: avg_moving_ms * 3.6,
            p95_speed_kmh: p95_ms * 3.6,
            distance_km: distance_m / 1000.0,
        }
    }

    /// Speeds only a motor sustains (beyond the 25 km/h ebike assist cap).
    fn is_moto(&self) -> bool {
        self.avg_moving_speed_kmh > MOTO_AVG_MOVING_KMH || self.p95_speed_kmh > MOTO_P95_KMH
    }

    /// Long/fast enough to be an ADV ride rather than an enduro loop.
    fn is_adv(&self) -> bool {
        self.distance_km > ADV_DISTANCE_KM
            || (self.avg_moving_speed_kmh > ADV_FAST_AVG_KMH
                && self.distance_km > ADV_FAST_DISTANCE_KM)
    }
}

/// Classify a ride's mode from FIT metadata plus its speed signature.
/// Returns one of the `ride_mode` enum values: adv | enduro | mtb | other.
pub fn classify_mode(
    fit_sport: Option<&str>,
    fit_sub_sport: Option<&str>,
    stats: &RideStats,
) -> &'static str {
    let sport = fit_sport.map(str::to_ascii_lowercase);
    let sub_sport = fit_sub_sport.map(str::to_ascii_lowercase).unwrap_or_default();

    match sport.as_deref() {
        // Anything on water
        Some(
            "swimming" | "sailing" | "kayaking" | "rowing" | "paddling" | "surfing"
            | "boating" | "windsurfing" | "kitesurfing" | "stand_up_paddleboarding"
            | "water_skiing" | "diving" | "fishing",
        ) => "watersport",
        // Flights go to other regardless of speed
        Some("flying" | "aviation" | "hang_gliding" | "paragliding") => "other",
        // Unambiguous non-riding land sports
        Some(
            "hiking" | "walking" | "running" | "cross_country_skiing" | "tactical"
            | "training" | "fitness_equipment",
        ) => "other",
        Some("motorcycling") => {
            if stats.is_adv() {
                "adv"
            } else {
                "enduro"
            }
        }
        Some("cycling") => {
            if sub_sport.starts_with("e_bike") {
                // Electric motorbike enduro vs eMTB — speed signature decides
                if stats.is_moto() { "enduro" } else { "mtb" }
            } else {
                "mtb"
            }
        }
        // generic (track_me/navigate), unknown sports, or no metadata:
        // classify purely from the speed signature.
        _ => {
            if stats.p95_speed_kmh > AIRCRAFT_P95_KMH {
                // Jet or light aircraft — no ground vehicle sustains this
                "other"
            } else if stats.avg_moving_speed_kmh < HIKING_MAX_AVG_KMH {
                "other"
            } else if stats.is_moto() {
                if stats.is_adv() { "adv" } else { "enduro" }
            } else {
                "mtb"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(avg: f64, p95: f64, dist: f64) -> RideStats {
        RideStats {
            avg_moving_speed_kmh: avg,
            p95_speed_kmh: p95,
            distance_km: dist,
        }
    }

    #[test]
    fn hiking_sport_is_other() {
        assert_eq!(classify_mode(Some("hiking"), None, &stats(4.0, 6.0, 12.0)), "other");
    }

    #[test]
    fn water_sports_are_watersport() {
        assert_eq!(classify_mode(Some("swimming"), Some("open_water"), &stats(3.0, 5.0, 2.0)), "watersport");
        assert_eq!(classify_mode(Some("kayaking"), None, &stats(6.0, 9.0, 12.0)), "watersport");
        assert_eq!(classify_mode(Some("sailing"), None, &stats(12.0, 20.0, 30.0)), "watersport");
    }

    #[test]
    fn sustained_aircraft_speed_is_other() {
        // Light aircraft cruising ~220 km/h under a track_me profile
        assert_eq!(
            classify_mode(Some("generic"), Some("track_me"), &stats(180.0, 220.0, 300.0)),
            "other"
        );
        // Jet
        assert_eq!(classify_mode(None, None, &stats(600.0, 780.0, 1200.0)), "other");
        // Fast highway ADV stays adv (p95 below the aircraft threshold)
        assert_eq!(
            classify_mode(Some("generic"), Some("track_me"), &stats(70.0, 115.0, 250.0)),
            "adv"
        );
    }

    #[test]
    fn cycling_mountain_is_mtb() {
        assert_eq!(
            classify_mode(Some("cycling"), Some("mountain"), &stats(15.0, 30.0, 25.0)),
            "mtb"
        );
    }

    #[test]
    fn ebike_profile_at_bike_speeds_is_mtb() {
        assert_eq!(
            classify_mode(Some("cycling"), Some("e_bike_mountain"), &stats(16.0, 32.0, 30.0)),
            "mtb"
        );
    }

    #[test]
    fn ebike_profile_at_moto_speeds_is_electric_enduro() {
        assert_eq!(
            classify_mode(Some("cycling"), Some("e_bike_mountain"), &stats(28.0, 60.0, 35.0)),
            "enduro"
        );
    }

    #[test]
    fn track_me_slow_is_hike() {
        assert_eq!(
            classify_mode(Some("generic"), Some("track_me"), &stats(4.5, 8.0, 9.0)),
            "other"
        );
    }

    #[test]
    fn track_me_moto_short_loop_is_enduro() {
        assert_eq!(
            classify_mode(Some("generic"), Some("track_me"), &stats(26.0, 58.0, 45.0)),
            "enduro"
        );
    }

    #[test]
    fn track_me_long_fast_is_adv() {
        assert_eq!(
            classify_mode(Some("generic"), Some("track_me"), &stats(48.0, 95.0, 220.0)),
            "adv"
        );
    }

    #[test]
    fn no_metadata_ebike_speeds_is_mtb() {
        assert_eq!(classify_mode(None, None, &stats(17.0, 33.0, 22.0)), "mtb");
    }
}
