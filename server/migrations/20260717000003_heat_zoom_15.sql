-- Strava's identified global heatmap actually serves z15 (z16 = 404); the
-- original z14 cap was based on the public heatmap. Allow harvesting to z15.
ALTER TABLE harvest_regions DROP CONSTRAINT harvest_regions_target_zoom_check;
ALTER TABLE harvest_regions ADD CONSTRAINT harvest_regions_target_zoom_check
    CHECK (target_zoom BETWEEN 0 AND 15);
