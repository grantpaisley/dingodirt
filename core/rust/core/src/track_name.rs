//! Whether a name a file carried is worth showing.
//!
//! Lives in core because two crates need the same answer: `dingo_ingest`
//! picks a ride's initial `name_source` with it (a junk original means the
//! ride should display the generated name instead), and `dingo_enrich`
//! re-exports it for the naming pass and its tests.

/// FIT sport strings and recorder defaults that carry no information.
const JUNK_NAMES: &[&str] = &[
    "cycling",
    "generic",
    "running",
    "hiking",
    "walking",
    "swimming",
    "motorcycling",
    "training",
    "transition",
    "mountain_biking",
    "e_biking",
    "fitness_equipment",
    "cross_country_skiing",
    "tactical",
    "track_me",
    "navigate",
    "untitled",
];

/// Whether an ingested name is meaningless boilerplate.
pub fn is_junk_name(name: Option<&str>) -> bool {
    let Some(name) = name else { return true };
    let n = name.trim().to_ascii_lowercase();
    if n.is_empty() {
        return true;
    }
    if JUNK_NAMES.contains(&n.as_str()) {
        return true;
    }
    n.starts_with("active log")
        || n.starts_with("track ")
        || n.starts_with("course")
        || n.starts_with("move ")
        // bare numbers, dates, timestamps ("2021-09-07 04:41")
        || n.chars().all(|c| c.is_ascii_digit() || " -:./".contains(c))
        // a previously generated name that leaked into original_name
        || (n.contains(" kms ") && n.contains(" on 2"))
}

#[cfg(test)]
mod tests {
    use super::is_junk_name;

    #[test]
    fn junk_names_detected() {
        assert!(is_junk_name(None));
        assert!(is_junk_name(Some("cycling")));
        assert!(is_junk_name(Some("Active Log: 02 Sep 2011 07:18 (segment 3)")));
        assert!(is_junk_name(Some("13")));
        assert!(is_junk_name(Some("2021-09-07 04:41")));
        assert!(is_junk_name(Some(
            "Hornsby:Berowra Waters loop 0 kms 0.0 hrs on 2024-03-14"
        )));
        assert!(!is_junk_name(Some("Maroota Secret Track")));
        assert!(!is_junk_name(Some("03031116 Thredbo downhill")));
    }
}
