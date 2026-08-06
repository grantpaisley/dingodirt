# dingodirt.com — community website & pack service

*Design, 2026-08-02. Brainstormed and validated section-by-section. Companion
to `2026-08-02-dingo-studio-design.md`, which deferred this spec.*

## Why

- Members should be able to create ride packs and schemes **for their
  friends** — private by default, shared by link, public by choice.
- The three apps (Plan, Nav, Studio) need a public home and a demo funnel.
- The Studio design assumed "GitHub is the store"; private-by-default packs
  and an in-app publish button need real storage with ownership — this spec
  supersedes the gallery/upload contract sketched there.

## Decision summary

| Question | Decision |
|---|---|
| Audience | Closed riding crew; public can view, members publish |
| Apex domain | `dingodirt.com` = community site (nothing attached today) |
| Coordination | Facebook group, linked from the site — **no forum in v1** (`forum.` reserved) |
| Stack | Next.js on Vercel; Neon Postgres + Vercel Blob |
| Pack store | **DB + blob for all packs** — dingo-shares retires to a dev/seed artifact |
| Sign-in | Auth.js: Google + Microsoft OAuth; cookie on `.dingodirt.com` (SSO with `plan.`) |
| Who signs in | **Authors only** — browsing, demo, and receiving packs need no account |
| Membership | Email allowlist table + waitlist with approval; GitHub identity reserved for platform dev |
| Visibility | `private` (default) → `unlisted` (capability link) → `public` (galleries) |
| Plan access | **Hosted multi-user Plan** at `plan.` — daemon user model is its own future design doc |
| Pack API home | On the site (Vercel/Neon), independent of daemon uptime |
| Folders | Author-side organization only, nestable; sharing stays per-pack |
| Stats | Private Vercel Analytics (visitors by country); per-pack download counts for owners |

## Architecture

```
dingodirt.com      Next.js on Vercel — site + pack API + auth   [NEW repo: DingoDirt]
plan.dingodirt.com hosted multi-user Dingo Plan (frontend on Vercel)
api.dingodirt.com  Rust daemon + PostGIS (VPS, later; separate design)
nav. / studio. / demo.  static PWAs on GitHub Pages (demo = Studio's showcase)
forum.             reserved, unused
Neon Postgres      users, allowlist, waitlist, packs, pack_versions, folders
Vercel Blob        pack zips, preview images
```

The site holds community infrastructure; the daemon holds planning
infrastructure. Share links and galleries never depend on the VPS being up.

Flow: `author (Plan/Studio publish button, or /publish upload) → pack API →
DB+Blob → capability link → friends (Nav/Plan, no account)`.

## Pack model

One `packs` table for both kinds: `id`, `owner_id`, `type` (`ride`|`scheme`),
`name`, `slug`, `visibility`, `share_token`, `folder_id?`, `current_version`,
timestamps. Each upload adds a `pack_versions` row (`version`, `blob_url`,
`size`, `checksum`, extracted metadata: distance/region for rides, colours for
schemes, preview image). Pages and links always serve `current_version` —
**links survive version bumps**.

Visibility:

- **private** — owner only. Default on upload.
- **unlisted** — anyone with `dingodirt.com/p/<share_token>` (unguessable
  capability URL) can view/download; not listed anywhere.
- **public** — also listed in `/rides` or `/schemes`; gets alias
  `/rides/<slug>` etc.

Downloads always stream through the API (blob URLs never exposed), so
re-privatizing kills the link immediately. **Retract** = soft delete, blob
kept 30 days. **Folders**: `folders` (`owner_id`, `parent_id`, `name`),
nestable, dashboard-only organization; no folder-level sharing (a later
"collections" feature can layer on without rework).

**App contract:** *Ride it* → `nav.dingodirt.com/?dl=<capability-url>`;
`?scheme=<capability-url>` likewise. Nav/Studio need only CORS-friendly
fetches, which the API provides.

## Auth & membership

Auth.js (NextAuth v5), Google + Microsoft providers. First sign-in creates a
`users` row. Session cookie on `.dingodirt.com` — one login for site and Plan.

Roles via allowlist table (email → role):

- **visitor** — signed in, not allowlisted: browse public content only.
- **member** — publish / version / retract / visibility on own packs;
  dashboard.
- **admin** — plus allowlist & waitlist management, hide/delete any pack
  (moderation path).

**Waitlist:** non-members see *Join the waitlist* — email, *where did you
hear about dingodirt?* (Facebook group / a mate / other), and the mate's
email if referred (the vouch is the approval signal), plus an **optional**
"you and your bike" photo (community flair, deliberately not identity
proof — a mandatory face photo was considered and rejected: unverifiable,
high-friction, and a privacy liability). Protected by Cloudflare Turnstile.
Admin approves → allowlisted.

**Publish buttons:** Plan (same parent domain) POSTs with the shared cookie.
Studio (GitHub Pages) opens a `dingodirt.com` popup, hands over the pack via
`postMessage`, popup confirms and uploads under the site session.

## Pages

- `/` — what Dingo is; Plan/Nav/Studio cards; *Watch the demo* → `demo.`;
  Facebook group link; recent public packs strip.
- `/rides`, `/schemes` — public galleries: preview, name, author;
  distance/region (rides) or colour swatches (schemes); newest first; simple
  name/author search.
- `/p/<token>` — pack page (the shareable unit): preview, metadata, primary
  action (*Ride it* / *Plan with it* / *Remix in Studio*), *Copy link*.
- `/dashboard` — member's pack tree (folders): visibility toggle, version,
  downloads, copy link, update, retract.
- `/publish` — drag-and-drop upload → validation → pack page with link ready.
- `/admin` — waitlist approvals, allowlist editor, all-packs moderation.

Look & feel: map-forward, dark-friendly, sibling of the apps (optionally
themed by the default `.dingoscheme` — cute, not v1-blocking).

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/packs` | member | New pack, or new version (same name+owner → bump) |
| `GET /api/packs/:token` | capability | Metadata for pages and apps |
| `GET /api/packs/:token/download` | capability | Stream zip; CORS open; count download |
| `PATCH /api/packs/:id` | owner | Visibility, rename, description, folder |
| `DELETE /api/packs/:id` | owner/admin | Retract (soft delete) |
| `GET /api/gallery?type=` | none | Public packs |
| `POST /api/waitlist` | Turnstile | Join waitlist |
| `/api/admin/*` | admin | Allowlist, waitlist, moderation |

**Upload validation** (nothing invalid is ever stored, plain-message
rejections): not a zip, over size cap (~50 MB), missing/unparseable
`bundle.json`/`scheme.json`, unsupported `schemaVersion`, name collision with
another member's pack.

**Failure behavior:** bad/retracted token → friendly "no longer shared" page,
never a raw 404. Downloads complete or error — never half-serve. Rate limits
on upload (per member) and waitlist (per IP).

## Analytics

Vercel Analytics, private — visitors by country is the v1 "users per
country". Download counts in the DB, shown to pack owners. No public stats,
no extra cookies.

## Testing

1. **Upload validation** — fixture zips: good ride/scheme, truncated,
   oversized, bad manifest, wrong `schemaVersion`, collisions.
2. **Capability semantics** — private link fails; unlisted works but
   unlisted; re-private kills link; retract → friendly page; version bump
   serves new bytes at same link.
3. **Auth boundaries** — non-member can't publish; member can't touch
   another's pack; admin can.
4. **App contract smoke** — fixture pack on a preview deploy fetched via
   `?dl=` by real Nav before release.

## Rollout (each step useful alone)

1. Site skeleton + landing + auth + waitlist
2. Pack service: upload, dashboard, visibility, capability links (Dave's
   story end-to-end via `/publish`)
3. Galleries + pack pages
4. Studio/Plan publish buttons
5. Admin polish: approvals, moderation, download stats

Until the daemon's multi-user work lands, hosted Plan is the story's one gap:
authors fall back to exporting a pack and using `/publish` — everything else
is unchanged.

## Deferred (YAGNI'd)

Forum (`forum.` reserved), profiles beyond a display name, comments/ratings,
events/writeups/news, public stats page, shareable folders/collections,
teams, email notifications, search beyond name/author — waiting for actual
users to ask.

**White-label community sites (noted 2026-08-03, future direction):** offer
trail communities their own branded mini-site in the mould of ad-hoc trail
sites like the GOAT (Great Oz Adventure Trail) Google Site — their name,
their colours (a `.dingoscheme` doubling as the site theme), their curated
packs and pages, powered by the dingodirt pack service underneath (e.g.
`goat.dingodirt.com` or a custom domain). The pack model already fits
(folders/collections per community, capability links); what it adds is
multi-tenant theming + curated content pages. Revisit once a second real
community wants in.

## Monetization (direction, not commitment — noted 2026-08-03)

Working idea: planning free, privacy paid ("pay for privacy", the old
GitHub-private-repos model). Assessment from the 2026-08-03 discussion:

**What works.** Free users default to public, which seeds the galleries —
every free user enriches the commons. And genuine privacy needs skew
commercial (tour operators, event organizers hiding a route until race day,
guides protecting loops) — the users with willingness to pay.

**Known tensions.**

- *Inverted cost structure:* hosted Plan (daemon + PostGIS + VPS +
  per-user libraries) is the expensive product; private packs cost ~nothing.
  Subscriptions must be understood as funding Plan's infra.
- *Unlisted is the leak:* the core "pack for friends" flow runs on unlisted
  links, which are 95% of private. Paywalling unlisted kills the Dave story;
  leaving it free thins the privacy paywall. Resolution: gate **scale**, not
  the toggle.
- *Private tracks ≠ private packs:* private tracks are really a hosted-Plan
  seat — price that as Plan tiers, which maps price to cost honestly.

**Sketched tiers (when the community outgrows free-for-all):**

- **Free** — public packs, a few active private/unlisted packs, basic
  planning.
- **Paid individual** — unlimited private/unlisted, own Plan library
  (Strava sync, heatmap contribution), folders/collections.
- **White-label (B2B)** — branded community sites (above); likely the
  strongest revenue line — fewer, larger, less awkward than charging mates.

**Now:** nothing is gated. The crew allowlist doubles as grandfathering.
Schema takes tiers without rework (a `tier` column on users when needed).

## The validated user story ("Dave")

Dave hears of dingodirt in the Facebook group → joins the waitlist ("Steve
invited me") → approved → signs into hosted Plan with Google → builds
Sunday's route → **Publish** (no file touches his machine) → pack appears
private in his dashboard → flips to **unlisted**, copies
`dingodirt.com/p/x7Kq…` → pastes in the group chat → mates tap it, hit **Ride
it**, Nav downloads it offline-ready — no accounts → route changes Thursday:
re-publish, same link, silent v2 → great ride: flips it **public**, it
appears in `/rides`. Rained out instead? **Retract** → link shows "no longer
shared."
