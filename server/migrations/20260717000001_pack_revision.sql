-- Pack publish revision: bumped on every publish and embedded in the
-- bundle's bundle.json, so DingoNav can show which version a rider is on.
-- 0 = never published (matches the "plain download" revision in bundles
-- built outside the packs flow).
ALTER TABLE packs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
