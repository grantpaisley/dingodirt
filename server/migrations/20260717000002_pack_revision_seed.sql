-- Packs published before revisions existed have been out at least once:
-- start them at 1 so their next publish reads v2, not v1.
UPDATE packs SET revision = 1 WHERE published_at IS NOT NULL AND revision = 0;
