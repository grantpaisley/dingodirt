-- Marks sync (Docs/plans/2026-07-18-marks-sync-design.md): typed ride cues
-- harvested from DingoNav's ntfy ride topic, reviewed per-edit in the pack UI,
-- and baked into published bundles.

-- The group-ride channel name, minted at first publish (pack name + year,
-- e.g. Kandos2026) and frozen — re-deriving it later would move the group to
-- a different ntfy topic mid-conversation.
ALTER TABLE packs ADD COLUMN ride_name text;

CREATE TABLE pack_mark_edits (
    id           text NOT NULL,              -- DingoNav's hash id (idempotency key)
    pack_id      uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
    op           text NOT NULL,              -- add | remove
    kind         text NOT NULL DEFAULT 'turn',
    dir          text,                       -- L | R | S, turns only
    lat          double precision NOT NULL,
    lon          double precision NOT NULL,
    edited_at    timestamptz NOT NULL,       -- DingoNav's t
    edited_by    text NOT NULL DEFAULT 'rider',
    status       text NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
    harvested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pack_id, id)
);
