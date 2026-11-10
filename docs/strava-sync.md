# Strava auto-sync

`dingo strava sync` pulls your own new Strava activities into Dingo. New rides
appear without manual exports. The API has no raw-file download. Thus Dingo
rebuilds each activity as GPX from Strava's streams (GPS + time + altitude + HR)
and ingests it with `source = 'strava'`.

## One-time setup (~3 minutes, needs a browser)

1. Create a free API app at <https://www.strava.com/settings/api>.
   Use any name and site. Set **Authorization Callback Domain: `localhost`**.
2. Add to `.env`:

   ```
   STRAVA_CLIENT_ID=12345
   STRAVA_CLIENT_SECRET=abc123...
   ```

3. Run `dingo strava auth`. Approve the request in the browser. The tokens land
   in `~/.config/dingo/strava.json` (0600). Do this once; the tool refreshes the
   tokens automatically.

## Syncing

```bash
dingo strava sync                 # everything newer than the newest DB ride
dingo strava sync --since 2026-06-01
dingo strava sync --limit 20
```

Dingo cleans and gazetteer-locates the new rides automatically. Run
`dingo organize` to file them into the library. Notes:

- Dingo skips manual/trainer activities (no GPS).
- Stream-rebuilt GPX never byte-matches a Garmin original. Thus, if the same
  ride also arrives via a Garmin/Strava archive, `dingo dedupe-rides` is the
  tie-breaker (as usual).
- The rate limits (200 req/15 min) allow about 90 activities per burst. `sync`
  imports newest-first, so you can simply run it again.
- Cron idea: `dingo strava sync && dingo organize --src <inbox> --dest <library>`.
