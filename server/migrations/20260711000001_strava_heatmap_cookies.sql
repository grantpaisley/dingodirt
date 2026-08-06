-- Strava global heatmap overlay: cached CloudFront-signed tile cookies.
--
-- Strava serves authenticated heatmap tiles gated by three CloudFront cookies
-- (Key-Pair-Id / Policy / Signature, ~1 week expiry). OAuth cannot produce them
-- and (as of 2026-07) the login is a React SPA behind reCAPTCHA, so headless
-- login is dead — the user pastes the three cookie values from a logged-in
-- browser. This table caches them so they survive daemon restarts.
--
-- Single logical row, pinned by a CHECK so upserts are trivial (ON CONFLICT
-- (id) with id = TRUE).
CREATE TABLE strava_heatmap_cookies (
    id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
    key_pair_id  TEXT        NOT NULL,
    policy       TEXT        NOT NULL,
    signature    TEXT        NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
