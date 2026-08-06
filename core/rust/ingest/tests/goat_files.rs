//! Smoke test against the real G.O.A.T route archives.
//!
//! The archives live outside the repo (~/Desktop/Projects/Dingo-data/
//! planned-routes/), so this test is `#[ignore]`d for CI; run locally with
//! `cargo test -p dingo_ingest -- --ignored`.

use dingo_ingest::parse_gpx_file;

#[test]
#[ignore = "needs the external Dingo-data archive"]
fn parses_all_goat_archives() {
    let dir = dirs_home().join("Desktop/Projects/Dingo-data/planned-routes");
    let entries: Vec<_> = std::fs::read_dir(&dir)
        .expect("planned-routes dir present")
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("gpx"))
        })
        .collect();
    assert!(!entries.is_empty(), "no GPX files in {}", dir.display());

    let mut total_tracks = 0;
    let mut total_waypoints = 0;
    for entry in entries {
        let contents = std::fs::read(entry.path()).unwrap();
        let parsed = parse_gpx_file(&contents)
            .unwrap_or_else(|e| panic!("{}: {e}", entry.path().display()));

        assert!(!parsed.tracks.is_empty(), "{:?} has no tracks", entry.path());
        for track in &parsed.tracks {
            assert!(track.name.is_some(), "unnamed track in {:?}", entry.path());
            assert!(track.points.len() >= 2);
        }
        for wp in &parsed.waypoints {
            assert!(wp.lat.is_finite() && wp.lon.is_finite());
            if let Some(desc) = &wp.description {
                assert!(!desc.contains("<br"), "unstripped HTML: {desc}");
            }
        }
        total_tracks += parsed.tracks.len();
        total_waypoints += parsed.waypoints.len();
    }

    println!("parsed {total_tracks} tracks, {total_waypoints} waypoints");
    // 9 archives, 371 <trk> elements (multi-segment tracks may add more),
    // 3,047 <wpt> elements as of the 2026-07-28 downloads
    assert!(total_tracks >= 371);
    assert_eq!(total_waypoints, 3047);
}

fn dirs_home() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").expect("HOME set"))
}
