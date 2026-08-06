//! Live Routes API integration test — runs only when GOOGLE_MAPS_API_KEY is
//! set, so CI (no key) skips it silently. Exercises the real resolve →
//! parse → route chain on Grant's Greenbank-loop share link.

#[tokio::test]
async fn resolves_routes_and_builds_gpx() {
    let Ok(api_key) = std::env::var("GOOGLE_MAPS_API_KEY") else {
        eprintln!("GOOGLE_MAPS_API_KEY not set — skipping live Routes API test");
        return;
    };

    let url = "https://maps.app.goo.gl/452uG78w5P8SiX416";
    let full = dingo_google::resolve_url(url).await.expect("resolve");
    assert!(full.contains("/maps/dir/"), "resolved to: {full}");

    let req = dingo_google::parse_dir_url(&full).expect("parse");
    assert_eq!(req.waypoints.len(), 4);

    let points = dingo_google::compute_route(&req, &api_key).await.expect("route");
    // A ~35 km suburban loop decodes to thousands of polyline points.
    assert!(points.len() > 500, "only {} points", points.len());

    let gpx = dingo_google::build_route_gpx(&req, url, &points);
    assert!(gpx.contains("<trkpt"));
    assert!(!gpx.contains("<time>"));
}
