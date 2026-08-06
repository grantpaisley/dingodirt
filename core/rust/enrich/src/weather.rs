//! Open-Meteo Historical Weather API client

use chrono::{Duration, NaiveDate};
use reqwest::Client;
use serde::Deserialize;
use thiserror::Error;
use tracing::debug;

/// Weather API errors
#[derive(Debug, Error)]
pub enum WeatherError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("API error: {0}")]
    Api(String),

    #[error("Missing data for date {0}")]
    MissingData(NaiveDate),
}

/// Daily weather data extracted for a ride.
///
/// Every field is optional: a missing value from the API is propagated as `None`
/// rather than fabricated (previously null precip became 0.0mm and null temps
/// became 20/10°C — invented readings that then drove condition inference).
#[derive(Debug, Clone)]
pub struct DailyWeather {
    /// Precipitation on the day before the ride (mm)
    pub precip_24h: Option<f32>,
    /// Precipitation over the two days before the ride day (mm)
    pub precip_48h: Option<f32>,
    /// Maximum temperature on the ride day (°C)
    pub temp_max: Option<f32>,
    /// Minimum temperature on the ride day (°C)
    pub temp_min: Option<f32>,
}

/// Open-Meteo API client for historical weather data
#[derive(Clone)]
pub struct OpenMeteoClient {
    client: Client,
    base_url: String,
}

impl Default for OpenMeteoClient {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenMeteoClient {
    /// Create a new client
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            base_url: "https://archive-api.open-meteo.com/v1/archive".to_string(),
        }
    }

    /// Fetch weather data for a ride at a given location and date
    ///
    /// Returns daily weather including precipitation from the preceding 48 hours
    pub async fn fetch_daily_weather(
        &self,
        lat: f64,
        lon: f64,
        date: NaiveDate,
    ) -> Result<DailyWeather, WeatherError> {
        // Fetch 3 days of data: 2 days before + ride day for 48h precipitation
        let start_date = date - Duration::days(2);
        let end_date = date;

        let url = format!(
            "{}?latitude={}&longitude={}&start_date={}&end_date={}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=auto",
            self.base_url, lat, lon, start_date, end_date
        );

        debug!(url = %url, "Fetching weather data");

        let response = self.client.get(&url).send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(WeatherError::Api(format!("{status}: {body}")));
        }

        let api_response: ApiResponse = response.json().await?;

        // Extract data for the 3 days
        let daily = api_response.daily;

        // We expect 3 days of data
        if daily.time.len() < 3 {
            return Err(WeatherError::MissingData(date));
        }

        // Index: 0 = 2 days ago, 1 = yesterday, 2 = ride day.
        // We deliberately exclude the ride day from the precip windows: with only
        // daily totals we can't separate rain that fell before the ride from rain
        // after it, and including the whole ride day let an afternoon downpour
        // classify a dry morning ride as wet. The two preceding days are the
        // antecedent moisture that actually determines trail state.
        let precip_2_days_ago = daily.precipitation_sum.first().copied().flatten();
        let precip_yesterday = daily.precipitation_sum.get(1).copied().flatten();

        let temp_max = daily.temperature_2m_max.get(2).copied().flatten();
        let temp_min = daily.temperature_2m_min.get(2).copied().flatten();

        // precip_24h = day before the ride; precip_48h = two days before. Either
        // window is None (unknown) if any day it covers is missing, so inference
        // stays honest instead of treating a gap as "no rain".
        let precip_24h = precip_yesterday;
        let precip_48h = match (precip_2_days_ago, precip_yesterday) {
            (Some(a), Some(b)) => Some(a + b),
            _ => None,
        };

        Ok(DailyWeather {
            precip_24h,
            precip_48h,
            temp_max,
            temp_min,
        })
    }
}

/// API response structure from Open-Meteo
#[derive(Debug, Deserialize)]
struct ApiResponse {
    daily: DailyData,
}

#[derive(Debug, Deserialize)]
struct DailyData {
    time: Vec<String>,
    precipitation_sum: Vec<Option<f32>>,
    temperature_2m_max: Vec<Option<f32>>,
    temperature_2m_min: Vec<Option<f32>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_fetch_weather() {
        let client = OpenMeteoClient::new();
        let date = NaiveDate::from_ymd_opt(2024, 6, 15).unwrap();

        // Brisbane coordinates
        let result = client.fetch_daily_weather(-27.47, 153.02, date).await;
        assert!(result.is_ok());

        let weather = result.unwrap();
        println!("Weather: {weather:?}");
    }
}
