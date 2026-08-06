-- Share links become living links: one gist per share name (slug), updated in
-- place on re-share, so a mate's existing link always serves the latest
-- revision (raw gist URLs without a revision sha redirect to the newest one).
CREATE TABLE shares (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    -- pack key shared with DingoNav; same name => same pack on the phone
    slug        TEXT NOT NULL UNIQUE,
    gist_id     TEXT NOT NULL,
    gist_user   TEXT NOT NULL,
    ride_ids    UUID[] NOT NULL,
    revision    INT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
