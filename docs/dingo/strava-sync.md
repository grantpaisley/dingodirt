# Strava auto-sync

`dingo strava sync` pulls your own new Strava activities into Dingo — new
rides appear without manual exports. The API has no raw-file download, so each
activity is rebuilt as GPX from Strava's streams (GPS + time + altitude + HR)
and ingested with `source = 'strava'`.

## One-time setup (~3 minutes, needs a browser)

1. Create a free API app at <https://www.strava.com/settings/api>
   — any name/site; **Authorization Callback Domain: `localhost`**.
2. Add to `.env`:

   ```
   STRAVA_CLIENT_ID=12345
   STRAVA_CLIENT_SECRET=abc123...
   ```

3. Run `dingo strava auth` — approve in the browser; tokens land in
   `~/.config/dingo/strava.json` (0600). Done once, refreshed automatically.

## Syncing

```bash
dingo strava sync                 # everything newer than the newest DB ride
dingo strava sync --since 2026-06-01
dingo strava sync --limit 20
```

New rides are cleaned + gazetteer-located automatically; run `dingo organize`
to file them into the library. Notes:

- Manual/trainer activities (no GPS) are skipped.
- Stream-rebuilt GPX never byte-matches a Garmin original, so if the same
  ride also arrives via a Garmin/Strava archive, `dingo dedupe-rides` is the
  tie-breaker (as usual).
- Rate limits (200 req/15 min) allow ~90 activities per burst — `sync`
  imports newest-first and can just be re-run.
- Cron idea: `dingo strava sync && dingo organize --src <inbox> --dest <library>`.
