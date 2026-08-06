-- Persisted per-ride HR/speed stats.
--
-- The ride list API used to compute these per request with
-- jsonb_array_elements over cleaned_time_series — fine at 2k rides,
-- ~10s per wide-viewport request at 30k. Store them on the row instead;
-- the clean step maintains them (recomputed whenever a ride is cleaned),
-- and this migration backfills every already-cleaned ride once.
--
-- DOUBLE PRECISION (not REAL): the API reads these as f64, and sqlx
-- try_get with a mismatched float width fails at runtime.

ALTER TABLE rides
    ADD COLUMN IF NOT EXISTS avg_hr DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS max_hr DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS avg_speed_kmh DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS max_speed_kmh DOUBLE PRECISION;

-- One-time backfill (same formulas the list API used: moving = speed > 0.5 m/s)
UPDATE rides r SET
    avg_hr = s.avg_hr,
    max_hr = s.max_hr,
    avg_speed_kmh = s.avg_speed_kmh,
    max_speed_kmh = s.max_speed_kmh
FROM (
    SELECT r2.id,
           AVG((p->>'heart_rate')::float)
               FILTER (WHERE (p->>'heart_rate') IS NOT NULL
                         AND (p->>'speed_ms')::float > 0.5) AS avg_hr,
           MAX((p->>'heart_rate')::float)
               FILTER (WHERE (p->>'heart_rate') IS NOT NULL) AS max_hr,
           AVG((p->>'speed_ms')::float)
               FILTER (WHERE (p->>'speed_ms')::float > 0.5) * 3.6 AS avg_speed_kmh,
           MAX((p->>'speed_ms')::float) * 3.6 AS max_speed_kmh
    FROM rides r2
    CROSS JOIN LATERAL jsonb_array_elements(r2.cleaned_time_series) p
    GROUP BY r2.id
) s
WHERE s.id = r.id;
