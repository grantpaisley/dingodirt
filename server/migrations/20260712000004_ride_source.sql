-- Where a track came from: free text like 'wikiloc', 'dsra', 'dmd-hub',
-- 'strava', or a mate's name. Set by the Inbox/<source>/ folder convention in
-- `dingo organize`, the web import dialog, and `dingo strava sync`. NULL for
-- everything ingested before this existed (Grant's own recordings).
ALTER TABLE rides ADD COLUMN source text;
