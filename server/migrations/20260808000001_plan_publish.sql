-- Planning-mode publish: a pack can have a lightweight plan page on the
-- site alongside (or before) its full ride pack — simplified geometry the
-- group picks tracks from (docs/plans/2026-08-07-planning-mode-design.md).
-- The plan is its own site pack with its own share token.
ALTER TABLE packs
    ADD COLUMN site_plan_id     text,
    ADD COLUMN plan_share_token text;
