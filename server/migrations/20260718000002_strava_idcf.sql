-- Strava moved heat tiles to content-a.strava.com/identified/..., which needs
-- the _strava_idcf identity JWT alongside the three CloudFront cookies (the
-- session cookie is NOT required). Nullable: rows pasted before this column
-- fail auth on the new endpoint and surface the existing "reconnect" message.
ALTER TABLE strava_heatmap_cookies ADD COLUMN IF NOT EXISTS idcf TEXT;
