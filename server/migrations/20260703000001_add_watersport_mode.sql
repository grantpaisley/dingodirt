-- New riding mode: watersport (anything on water — swim, kayak, sail, boat, SUP).
-- Added to both enums so rides and runs stay aligned.
ALTER TYPE ride_mode ADD VALUE IF NOT EXISTS 'watersport';
ALTER TYPE riding_mode ADD VALUE IF NOT EXISTS 'watersport';
