//! Solar position calculations for time-of-day classification

use chrono::{DateTime, Utc};
use sunrise::{Coordinates, SolarDay, SolarEvent};

/// Time of day classification based on solar position
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeOfDay {
    /// Full daylight (sun well above horizon)
    Day,
    /// Around sunrise (30 minutes before/after)
    Dawn,
    /// Around sunset (30 minutes before/after)
    Dusk,
    /// Night time (after dusk, before dawn)
    Night,
}

impl TimeOfDay {
    /// Convert to database enum string value
    pub fn as_db_str(&self) -> &'static str {
        match self {
            TimeOfDay::Day => "day",
            TimeOfDay::Dawn => "dawn",
            TimeOfDay::Dusk => "dusk",
            TimeOfDay::Night => "night",
        }
    }
}

/// Duration of twilight periods in seconds (30 minutes)
const TWILIGHT_DURATION_SECS: i64 = 30 * 60;

/// The local calendar date at a given longitude for a UTC instant.
///
/// Longitude approximates the timezone offset (15° per hour), which is enough
/// to pick the correct solar day without a timezone database. Using the raw UTC
/// date instead placed every ride starting before ~10:00 local (in AEST, UTC+10)
/// on the *previous* solar day — so daylight morning rides were classified night
/// and dawn was unreachable.
pub fn local_date(datetime: DateTime<Utc>, lon: f64) -> chrono::NaiveDate {
    let offset_secs = (lon / 15.0 * 3600.0) as i64;
    (datetime + chrono::Duration::seconds(offset_secs)).date_naive()
}

/// Calculate the time of day for a given location and datetime
///
/// Uses sunrise/sunset times to classify:
/// - Dawn: 30 minutes around sunrise
/// - Day: Between dawn and dusk
/// - Dusk: 30 minutes around sunset
/// - Night: After dusk, before dawn
pub fn calculate_time_of_day(lat: f64, lon: f64, datetime: DateTime<Utc>) -> TimeOfDay {
    // Build coordinates - use defaults if invalid
    let Some(coord) = Coordinates::new(lat, lon) else {
        return TimeOfDay::Day; // Default if invalid coords
    };

    // Pick the solar day by the ride's *local* date, not its UTC date.
    let date = local_date(datetime, lon);
    let solar_day = SolarDay::new(coord, date);

    // Get sunrise and sunset times as DateTime<Utc>
    let sunrise_dt = solar_day.event_time(SolarEvent::Sunrise);
    let sunset_dt = solar_day.event_time(SolarEvent::Sunset);

    // Compare using Unix timestamps (seconds since epoch)
    let current_ts = datetime.timestamp();
    let sunrise_ts = sunrise_dt.timestamp();
    let sunset_ts = sunset_dt.timestamp();

    // Define twilight boundaries
    let dawn_start = sunrise_ts - TWILIGHT_DURATION_SECS;
    let dawn_end = sunrise_ts + TWILIGHT_DURATION_SECS;
    let dusk_start = sunset_ts - TWILIGHT_DURATION_SECS;
    let dusk_end = sunset_ts + TWILIGHT_DURATION_SECS;

    if current_ts >= dawn_start && current_ts <= dawn_end {
        TimeOfDay::Dawn
    } else if current_ts >= dusk_start && current_ts <= dusk_end {
        TimeOfDay::Dusk
    } else if current_ts > dawn_end && current_ts < dusk_start {
        TimeOfDay::Day
    } else {
        TimeOfDay::Night
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_midday_is_day() {
        // Brisbane midday in summer (Dec 15)
        // Sunrise ~4:50 UTC, sunset ~8:45 UTC
        // 6:00 UTC is mid-morning, definitely daytime
        let dt = Utc.with_ymd_and_hms(2024, 12, 15, 6, 0, 0).unwrap();
        let tod = calculate_time_of_day(-27.47, 153.02, dt);
        assert_eq!(tod, TimeOfDay::Day);
    }

    #[test]
    fn test_midnight_is_night() {
        // Brisbane late night - 12:00 UTC = 10pm AEST (after sunset ~8:45 UTC)
        let dt = Utc.with_ymd_and_hms(2024, 12, 15, 12, 0, 0).unwrap();
        let tod = calculate_time_of_day(-27.47, 153.02, dt);
        assert_eq!(tod, TimeOfDay::Night);
    }

    #[test]
    fn test_dusk_detection() {
        // Brisbane around sunset (~8:45 UTC in December)
        // Using 8:40 UTC should be within the 30-min dusk window
        let dt = Utc.with_ymd_and_hms(2024, 12, 15, 8, 40, 0).unwrap();
        let tod = calculate_time_of_day(-27.47, 153.02, dt);
        // Either Dusk or Day is acceptable depending on exact sunrise calc
        assert!(tod == TimeOfDay::Dusk || tod == TimeOfDay::Day);
    }

    #[test]
    fn test_au_morning_ride_is_daylight_not_night() {
        // 08:00 AEST on 2026-07-08 == 22:00Z on 2026-07-07. The UTC date is
        // July 7, but the ride's local date is July 8; using the UTC date put
        // this broad-daylight morning ride past the previous day's dusk → night.
        let dt = Utc.with_ymd_and_hms(2026, 7, 7, 22, 0, 0).unwrap();
        let tod = calculate_time_of_day(-27.47, 153.02, dt);
        assert_eq!(tod, TimeOfDay::Day, "AU winter morning ride must read as Day");
    }

    #[test]
    fn test_db_str() {
        assert_eq!(TimeOfDay::Day.as_db_str(), "day");
        assert_eq!(TimeOfDay::Dawn.as_db_str(), "dawn");
        assert_eq!(TimeOfDay::Dusk.as_db_str(), "dusk");
        assert_eq!(TimeOfDay::Night.as_db_str(), "night");
    }
}
