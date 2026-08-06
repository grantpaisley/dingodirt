//! Politeness: request pacing and the off-peak window.
//!
//! The month-long pace is a feature — it keeps the harvest under the radar and
//! the account safe. Single worker, a few tiles/sec at most, jittered so the
//! cadence never looks mechanical.

use chrono::NaiveTime;
use rand::Rng;
use std::time::{Duration, Instant};

/// Token bucket with capacity 1: each `acquire` waits until the next jittered
/// slot. Capacity 1 is deliberate — no bursts, ever.
pub struct TokenBucket {
    interval: Duration,
    /// Relative jitter, e.g. 0.3 → each gap is uniform in ±30% of the interval.
    jitter: f64,
    next_at: Instant,
}

impl TokenBucket {
    pub fn new(per_sec: f64, jitter: f64) -> Self {
        let per_sec = per_sec.max(0.01); // 100s/tile floor guards a zero/negative flag
        Self {
            interval: Duration::from_secs_f64(1.0 / per_sec),
            jitter: jitter.clamp(0.0, 0.9),
            next_at: Instant::now(),
        }
    }

    /// Wait for the next request slot.
    pub async fn acquire(&mut self) {
        let now = Instant::now();
        if self.next_at > now {
            tokio::time::sleep(self.next_at - now).await;
        }
        let factor = 1.0 + rand::thread_rng().gen_range(-self.jitter..=self.jitter);
        self.next_at = Instant::now() + self.interval.mul_f64(factor);
    }
}

/// Daily off-peak window in local time, e.g. "22:00-06:00" (wraps midnight).
#[derive(Debug, Clone, Copy)]
pub struct Window {
    start: NaiveTime,
    end: NaiveTime,
}

impl Window {
    /// Parse "HH:MM-HH:MM".
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let (a, b) = s
            .split_once('-')
            .ok_or_else(|| anyhow::anyhow!("window must be HH:MM-HH:MM, got {s:?}"))?;
        Ok(Self {
            start: NaiveTime::parse_from_str(a.trim(), "%H:%M")?,
            end: NaiveTime::parse_from_str(b.trim(), "%H:%M")?,
        })
    }

    pub fn contains(&self, t: NaiveTime) -> bool {
        if self.start <= self.end {
            self.start <= t && t < self.end
        } else {
            // Wraps midnight, e.g. 22:00-06:00.
            t >= self.start || t < self.end
        }
    }
}

impl std::fmt::Display for Window {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}-{}", self.start.format("%H:%M"), self.end.format("%H:%M"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> NaiveTime {
        NaiveTime::parse_from_str(s, "%H:%M").unwrap()
    }

    #[test]
    fn plain_window() {
        let w = Window::parse("09:00-17:00").unwrap();
        assert!(w.contains(t("12:00")));
        assert!(!w.contains(t("18:00")));
        assert!(!w.contains(t("03:00")));
    }

    #[test]
    fn wrapping_window() {
        let w = Window::parse("22:00-06:00").unwrap();
        assert!(w.contains(t("23:30")));
        assert!(w.contains(t("03:00")));
        assert!(!w.contains(t("12:00")));
        assert!(!w.contains(t("06:00"))); // end is exclusive
    }

    #[test]
    fn bad_input() {
        assert!(Window::parse("late-night").is_err());
        assert!(Window::parse("22:00").is_err());
    }

    #[tokio::test]
    async fn bucket_paces_requests() {
        let mut b = TokenBucket::new(50.0, 0.0); // 20ms slots, no jitter
        let start = Instant::now();
        b.acquire().await; // first is immediate
        b.acquire().await;
        b.acquire().await;
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(40), "{elapsed:?}");
    }
}
