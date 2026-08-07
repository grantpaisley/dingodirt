# Plan → dingodirt.com publish (and the end of dingo-shares)

*2026-08-06 — brainstormed with Claude; supersedes the dingo-shares publish
flow in Plan and the `?b=` slug resolution in Nav.*

## Decision summary

- **The website replaces dingo-shares as the publish target.** Plan's Publish
  button uploads the built `.dingonav` to dingodirt.com via the local daemon.
  No dual-target period; old `?b=<slug>` links are allowed to break at Nav
  cutover. The dingo-shares repo is archived afterwards (manual step).
- **Auth: pasted API token.** Created on the dingodirt.com dashboard, pasted
  once into Plan's Settings, stored by the local daemon.
- **Visibility from Plan: two choices.** *Link only* (site `unlisted` — the
  `?b=` link works, not in galleries) and *Public* (site `pending` → review
  queue → `public`; trusted users go straight to `public`). The site's
  `private` tier is not offered from Plan — it would break share links, which
  are the whole point of publishing from Plan.
- **Plan stays a local app.** Users download and run Plan + daemon on their
  own machine. Hosting Plan online is explicitly deferred; nothing here
  prejudges it. `DINGO_SITE_URL` stays configurable so self-hosters can point
  at their own dingodirt instance.

## 1. Website: API tokens + machine upload

New `apiTokens` table: `id`, `userId`, `name`, `tokenHash` (SHA-256; the
`ddt_…` secret is shown once at creation), `lastUsedAt`, `createdAt`,
`revokedAt`. Dashboard gains an "API tokens" card: create / list with
last-used / revoke.

`POST /api/packs` changes:

- `Authorization: Bearer ddt_…` resolves the token to the same `SessionUser`
  the cookie path produces; everything downstream (validation, rate limit,
  moderation) is unchanged.
- Optional form field `visibility`: `unlisted` | `public`. `public` maps to
  `pending` exactly like the website's own flow (trusted skips the queue).
  Omitted → keep current visibility on version bumps, `unlisted` for new.
- Optional form field `packId`: when present and owned by the caller, the
  upload is a version bump of that pack regardless of name — so renaming a
  pack in Plan propagates instead of forking a new site pack.

`GET /api/packs/[token]/download` gains `Access-Control-Allow-Origin: *` —
Nav fetches it cross-origin from nav.dingodirt.com (raw.githubusercontent
gave this for free).

## 2. Daemon: publish goes to the site

- Config: `DINGO_SITE_URL` (default `https://dingodirt.com`); the API token
  lives in the daemon settings store, set via
  `PUT /api/settings/dingodirt-token`, never echoed back beyond a suffix.
  `GET /api/settings/dingodirt` reports connected-as by calling a cheap
  authenticated site endpoint.
- `publish_pack` keeps bundle building, swaps the tail: multipart POST to
  `{site}/api/packs` with Bearer token, `visibility` (from a new JSON body
  `{ visibility: "unlisted" | "public" }`), and stored `packId` when
  re-publishing. Stores `site_pack_id`, `share_token`, `visibility` on the
  pack row. `share_url` = `{nav}/?b=<share_token>`; `file_url` = the pack's
  dingodirt.com page. Site errors (401/400/429/503) pass through verbatim.
- All `gh`/git-push code, `DINGO_SHARE_REPO`, and the orphans listing are
  removed.

## 3. Plan UI

- Settings → "dingodirt.com account" card: paste-token field, Connect,
  status line ("Connected as Grant" / "Not connected" / "Token rejected"),
  Disconnect.
- PackDetail: Publish/Refresh keeps its place and stale badge but opens a
  confirm popover: Link only vs Public radios (first publish defaults Link
  only; re-publish defaults to current state, shown with live site state,
  e.g. "Public — pending review"), size estimate, then the share link +
  "View on dingodirt.com".
- Not connected → button leads to Settings. No file-handoff fallback
  (ExportDialog's download already covers unpublished export).
- Delete keeps its "also remove from dingodirt.com" checkbox (site
  soft-delete).

## 4. Nav repoint + retirement

`?b=<shareToken>` → `https://dingodirt.com/api/packs/<token>/download`
(replace the `SHARES_REPO` builder in index.html). Sha-pinning goes away;
the site's version history covers it. Param name and caching stay identical.

## Cutover order (each step shippable alone)

1. Site: tokens + upload changes + download CORS (curl-testable).
2. Daemon + Plan: new publish tail + Settings + popover (old links still
   work).
3. Nav: repoint `?b=` (old slug links break here — accepted).
4. Retire dingo-shares: archive repo (manual), delete daemon/Plan code
   paths.

## Testing

- Site: vitest — token auth (valid / revoked / wrong-user `packId`),
  visibility mapping, download CORS header.
- Daemon: integration test publishing to a mock site server.
- Nav: existing bundle-load test with the new URL shape.
