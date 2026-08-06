//! Trail condition inference from weather data

use crate::weather::DailyWeather;

/// Inferred trail condition
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrailCondition {
    Dry,
    Wet,
    Unknown,
}

impl TrailCondition {
    /// Convert to database enum string value
    pub fn as_db_str(&self) -> &'static str {
        match self {
            TrailCondition::Dry => "dry",
            TrailCondition::Wet => "wet",
            TrailCondition::Unknown => "unknown",
        }
    }
}

/// Confidence level for inferred data
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidenceLevel {
    Low,
    Medium,
    High,
}

impl ConfidenceLevel {
    /// Convert to database enum string value
    pub fn as_db_str(&self) -> &'static str {
        match self {
            ConfidenceLevel::Low => "low",
            ConfidenceLevel::Medium => "medium",
            ConfidenceLevel::High => "high",
        }
    }
}

/// Result of condition inference
#[derive(Debug, Clone)]
pub struct ConditionInference {
    pub condition: TrailCondition,
    pub confidence: ConfidenceLevel,
}

/// Infer trail condition from weather data
///
/// Logic:
/// - Dry (high): precip_48h < 2mm, temp > 0°C
/// - Dry (medium): precip_48h < 5mm, temp > 0°C
/// - Wet (high): precip_24h > 10mm
/// - Wet (medium): precip_24h > 5mm or precip_48h > 15mm
/// - Unknown (low): Inconclusive data
pub fn infer_condition(weather: &DailyWeather) -> ConditionInference {
    let precip_24h = weather.precip_24h;
    let precip_48h = weather.precip_48h;
    let temp_min = weather.temp_min;

    // Missing readings never conclude — an absent precip value is unknown, not
    // "no rain". `above_freezing` treats an unknown temperature as non-blocking.
    let above_freezing = temp_min.is_none_or(|t| t > 0.0);

    // High confidence wet: significant recent rain
    if precip_24h.is_some_and(|p| p > 10.0) {
        return ConditionInference {
            condition: TrailCondition::Wet,
            confidence: ConfidenceLevel::High,
        };
    }

    // Medium confidence wet: moderate rain
    if precip_24h.is_some_and(|p| p > 5.0) || precip_48h.is_some_and(|p| p > 15.0) {
        return ConditionInference {
            condition: TrailCondition::Wet,
            confidence: ConfidenceLevel::Medium,
        };
    }

    // Freezing conditions - unknown (could be icy, muddy, or anything)
    if temp_min.is_some_and(|t| t < 0.0) {
        return ConditionInference {
            condition: TrailCondition::Unknown,
            confidence: ConfidenceLevel::Low,
        };
    }

    // Dry verdicts require an actual precip reading — we can't call a ride dry
    // on missing data.
    if precip_48h.is_some_and(|p| p < 2.0) && above_freezing {
        return ConditionInference {
            condition: TrailCondition::Dry,
            confidence: ConfidenceLevel::High,
        };
    }

    if precip_48h.is_some_and(|p| p < 5.0) && above_freezing {
        return ConditionInference {
            condition: TrailCondition::Dry,
            confidence: ConfidenceLevel::Medium,
        };
    }

    // Inconclusive
    ConditionInference {
        condition: TrailCondition::Unknown,
        confidence: ConfidenceLevel::Low,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dry_high_confidence() {
        let weather = DailyWeather {
            precip_24h: Some(0.0),
            precip_48h: Some(0.5),
            temp_max: Some(25.0),
            temp_min: Some(15.0),
        };
        let result = infer_condition(&weather);
        assert_eq!(result.condition, TrailCondition::Dry);
        assert_eq!(result.confidence, ConfidenceLevel::High);
    }

    #[test]
    fn test_wet_high_confidence() {
        let weather = DailyWeather {
            precip_24h: Some(15.0),
            precip_48h: Some(20.0),
            temp_max: Some(18.0),
            temp_min: Some(12.0),
        };
        let result = infer_condition(&weather);
        assert_eq!(result.condition, TrailCondition::Wet);
        assert_eq!(result.confidence, ConfidenceLevel::High);
    }

    #[test]
    fn test_wet_medium_confidence() {
        let weather = DailyWeather {
            precip_24h: Some(7.0),
            precip_48h: Some(10.0),
            temp_max: Some(20.0),
            temp_min: Some(10.0),
        };
        let result = infer_condition(&weather);
        assert_eq!(result.condition, TrailCondition::Wet);
        assert_eq!(result.confidence, ConfidenceLevel::Medium);
    }

    #[test]
    fn test_freezing_unknown() {
        let weather = DailyWeather {
            precip_24h: Some(1.0),
            precip_48h: Some(2.0),
            temp_max: Some(5.0),
            temp_min: Some(-2.0),
        };
        let result = infer_condition(&weather);
        assert_eq!(result.condition, TrailCondition::Unknown);
    }

    #[test]
    fn test_db_strings() {
        assert_eq!(TrailCondition::Dry.as_db_str(), "dry");
        assert_eq!(TrailCondition::Wet.as_db_str(), "wet");
        assert_eq!(TrailCondition::Unknown.as_db_str(), "unknown");
        assert_eq!(ConfidenceLevel::Low.as_db_str(), "low");
        assert_eq!(ConfidenceLevel::Medium.as_db_str(), "medium");
        assert_eq!(ConfidenceLevel::High.as_db_str(), "high");
    }
}
