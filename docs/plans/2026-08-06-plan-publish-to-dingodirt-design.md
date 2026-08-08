# Plan → dingodirt.com publish (and the end of dingo-shares)

*2026-08-06 — brainstormed with Claude. This document replaces the dingo-shares
publish flow in Plan and the `?b=` slug resolution in Nav.*

## Decision summary

- **The website replaces dingo-shares as the publish target.** Plan's Publish
  button uploads the built `.dingonav` to dingodirt.com through the local
  daemon. There is no dual-target period. Old `?b=<slug>` links can break at
  the Nav cutover. We archive the dingo-shares repo afterwards (a manual step).
- **Auth: a pasted API token.** The user creates the token on the
  dingodirt.com dashboard. The user pastes it once into Plan's Settings. The
  local daemon stores it.
- **Visibility from Plan: two choices.** *Link only* is the site `unlisted`
  tier — the `?b=` link works, but the pack is not in the galleries. *Public*
  is the site `pending` tier → review queue → `public`. Trusted users go
  straight to `public`. Plan does not offer the site's `private` tier. That
  tier would break the share links, and the share links are the whole point
  of a publish from Plan.
- **Plan stays a local app.** Users download and run Plan + the daemon on
  their own machine. We defer hosted Plan explicitly; nothing here prejudges
  it. `DINGO_SITE_URL` stays configurable, so self-hosters can point at their
  own dingodirt instance.

## 1. Website: API tokens + machine upload

A new `apiTokens` table has these columns: `id`, `userId`, `name`,
`tokenHash` (SHA-256; we show the `ddt_…` secret once at creation),
`lastUsedAt`, `createdAt`, `revokedAt`. The dashboard gets an "API tokens"
card. The card can create a token, list tokens with the last-used time, and
revoke a token.

`POST /api/packs` changes:

- `Authorization: Bearer ddt_…` resolves the token to the same `SessionUser`
  that the cookie path produces. Everything downstream (validation, rate
  limit, moderation) is unchanged.
- The optional form field `visibility`: `unlisted` | `public`. `public` maps
  to `pending`, exactly like the website's own flow (a trusted user skips the
  queue). If the field is not present, a version bump keeps the current
  visibility, and a new pack gets `unlisted`.
- The optional form field `packId`: when it is present, and the caller owns
  the pack, the upload is a version bump of that pack, regardless of the
  name. Thus a pack rename in Plan propagates and does not fork a new site
  pack.

`GET /api/packs/[token]/download` gets `Access-Control-Allow-Origin: *` —
Nav fetches it cross-origin from nav.dingodirt.com (raw.githubusercontent
gave this for free).

## 2. Daemon: publish goes to the site

- Config: `DINGO_SITE_URL` (default `https://dingodirt.com`). The API token
  lives in the daemon settings store. `PUT /api/settings/dingodirt-token`
  sets it, and the daemon never echoes it back beyond a suffix.
  `GET /api/settings/dingodirt` reports the connected-as identity. It does
  this with a call to a cheap authenticated site endpoint.
- `publish_pack` keeps the bundle build and swaps the tail. The tail is a
  multipart POST to `{site}/api/packs` with the Bearer token, `visibility`,
  and the stored `packId` on a re-publish. The `visibility` value comes from
  a new JSON body `{ visibility: "unlisted" | "public" }`. The daemon stores
  `site_pack_id`, `share_token`, and `visibility` on the pack row.
  `share_url` = `{nav}/?b=<share_token>`; `file_url` = the pack's
  dingodirt.com page. Site errors (401/400/429/503) pass through verbatim.
- We remove all `gh`/git-push code, `DINGO_SHARE_REPO`, and the orphans
  listing.

## 3. Plan UI

- Settings → "dingodirt.com account" card: a paste-token field, a Connect
  button, a status line ("Connected as Grant" / "Not connected" / "Token
  rejected"), and a Disconnect button.
- PackDetail: Publish/Refresh keeps its place and its stale badge, but it
  opens a confirm popover. The popover has Link only vs Public radios. The
  first publish defaults to Link only. A re-publish defaults to the current
  state, shown with the live site state, e.g. "Public — pending review". The
  popover also shows a size estimate, then the share link +
  "View on dingodirt.com".
- Not connected → the button leads to Settings. There is no file-handoff
  fallback (the download in ExportDialog already covers an unpublished
  export).
- Delete keeps its "also remove from dingodirt.com" checkbox (a site
  soft-delete).

## 4. Nav repoint + retirement

`?b=<shareToken>` → `https://dingodirt.com/api/packs/<token>/download`
(this replaces the `SHARES_REPO` builder in index.html). Sha-pinning goes
away; the site's version history covers it. The param name and the caching
stay identical.

## Cutover order (each step shippable alone)

1. Site: the tokens + the upload changes + the download CORS
   (curl-testable).
2. Daemon + Plan: the new publish tail + Settings + the popover (old links
   still work).
3. Nav: repoint `?b=` (old slug links break here — accepted).
4. Retire dingo-shares: archive the repo (manual), and delete the
   daemon/Plan code paths.

## Testing

- Site: vitest — token auth (valid / revoked / wrong-user `packId`), the
  visibility mapping, and the download CORS header.
- Daemon: an integration test that publishes to a mock site server.
- Nav: the existing bundle-load test with the new URL shape.
