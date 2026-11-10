# Garmin Connect sync with a personal API key

Status: built on branch `feat/garmin-personal-api`, 2026-11-10. Not pushed.

## Why now

In October 2026 Garmin opened a **Personal API** tier. Any Garmin Connect user
can make a key at <https://connect.garmin.com/app/settings/personalApiToken>.
There is no application and no approval. The key is read-only and gives the
user their own activities, which includes the **original FIT file**.

Before this, the only routes were the GDPR export zip (manual, slow) and the
unofficial SSO libraries (garth, python-garminconnect), which Garmin blocks
with Cloudflare TLS fingerprinting since March 2026. The Personal API is the
supported route, and the original FIT is better than the Strava sync, which
must rebuild a GPX from streams.

## The API (as documented on 2026-11-10)

- Base URL: `https://personal.connectapi.garmin.com`.
- Token: `POST /personalapitoken-service/personal-api/personal-api-key/token`
  with header `Authorization: ApiKey <key>`. It returns an OAuth2 access token
  that is valid for 24 hours. There is no refresh token: ask again.
- The key expires after 30, 90, 180 or 365 days (the user picks). Garmin
  sends an email a week before. The key is shown only once.
- List: `GET /activitylist-service/activities/search/activities?start&limit&sortOrder`,
  newest first by default. Each item has `activityId`, `activityName`,
  `startTimeGMT` (`yyyy-MM-dd HH:mm:ss`) and `startLatitude` (absent for
  indoor activities).
- File: `GET /download-service/files/activity/{activityId}` returns a zip with
  the file in its original format (FIT for a Garmin device).
- Delivery is pull only. There are no webhooks for the Personal tier.

The token response body is not documented. The client accepts
`access_token`, `accessToken` or `token` in a JSON object, a bare JSON
string, or a plain-text token.

## What we built

One daemon module and one Plan Settings card. No new crate, no migration, no
CLI command.

### Daemon: `core/rust/daemon/src/routes/garmin.rs`

| Route | What it does |
|---|---|
| `GET /api/settings/garmin` | `{ connected, key_suffix, synced_through }`. It does not call Garmin. |
| `PUT /api/settings/garmin` `{ key }` | Gets a token with the key first. If Garmin accepts it, the key goes into `app_settings` (`garmin_api_key`). `null` disconnects. |
| `POST /api/settings/garmin/sync` `{ since?, limit? }` | Pulls new activities and ingests them. |

Sync steps:

1. Get a fresh access token (one call per sync; no token cache).
2. Find the watermark: `since` if given, else `garmin_synced_through` from
   `app_settings`, else the start time of the newest own ride in the database.
3. Page the list, newest first, until an activity starts at or before the
   watermark. Reverse to oldest first and take `limit` (default 50, maximum 200).
4. For each activity: skip it if it has no GPS start point; else download the
   zip, unpack it with `dingo_ingest::extract_tracks`, and ingest each member
   with `dingo_ingest::ingest_file` (origin own). The file hash dedupes
   activities that came in before from a GDPR export.
5. Tag new rides `source = 'garmin'`, then run the same post-ingest pipeline
   as a web upload (`import::postprocess_new_rides`: elevation, clean, name,
   turn cues, library placement, heat harvest).
6. Move the watermark forward only through the activities that succeeded in
   order. A failed activity holds the watermark, so the next sync tries it
   again. A 429 stops the run and reports it.

`GARMIN_API_URL` overrides the base URL. The tests and the browser check use
it to point the daemon at a mock.

### Plan: `apps/plan/src/components/Settings/GarminConnect.tsx`

A card under the dingodirt.com card in Settings, in the same style:
status line, **Connect / Replace key / Disconnect**, a password field for the
key, a **Sync now** button with an optional "from" date, and a one-line
result (`3 imported · 1 duplicate · 2 indoor skipped`). After a sync it
invalidates the same queries as the import dialog, so the new rides show.

## Decisions taken without the owner (overnight)

| Decision | Reason | Easy to change? |
|---|---|---|
| Key in `app_settings`, like the dingodirt.com token | Same pattern as the existing token. No migration. | Yes |
| Manual **Sync now**, no timer | Simplest. A timer in the daemon is ~20 lines when wanted. | Yes |
| No CLI command | The daemon is the desktop path. `dingo strava sync` stays as it is. | Yes |
| First sync starts at the newest ride in the database | It does not pull years of history by surprise. Use the "from" date to backfill. | Yes |

## Risks

- **The key is in the database.** Co-admins with database access can read it
  (the same as the dingodirt.com token). The key is read-only and expires.
- **Undocumented token body.** Handled by the lenient parser; the first real
  key will confirm the shape.
- **Rate limits are not documented.** A 429 stops the run cleanly; the
  watermark makes the next run continue.
- **Not tested against the real Garmin API.** No key was available overnight.
  The mock follows the published OpenAPI spec.
