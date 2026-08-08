# dingodirt.com — community website & pack service

*Design, 2026-08-02. Brainstormed and validated section-by-section. A
companion to `2026-08-02-dingo-studio-design.md`, which deferred this spec.*

## Why

- Members must be able to create ride packs and schemes **for their
  friends** — private by default, shared by link, public by choice.
- The three apps (Plan, Nav, Studio) need a public home and a demo funnel.
- The Studio design assumed "GitHub is the store". Private-by-default packs
  and an in-app publish button need real storage with ownership. Thus this
  spec replaces the gallery/upload contract in that design.

## Decision summary

| Question | Decision |
|---|---|
| Audience | A closed riding crew; the public can view, members publish |
| Apex domain | `dingodirt.com` = the community site (nothing attached today) |
| Coordination | The Facebook group, linked from the site — **no forum in v1** (`forum.` reserved) |
| Stack | Next.js on Vercel; Neon Postgres + Vercel Blob |
| Pack store | **DB + blob for all packs** — dingo-shares retires to a dev/seed artifact |
| Sign-in | Auth.js: Google + Microsoft OAuth; a cookie on `.dingodirt.com` (SSO with `plan.`) |
| Who signs in | **Authors only** — browsing, the demo, and pack receipt need no account |
| Membership | An email allowlist table + a waitlist with approval; GitHub identity reserved for platform dev |
| Visibility | `private` (default) → `unlisted` (capability link) → `public` (galleries) |
| Plan access | **Hosted multi-user Plan** at `plan.` — the daemon user model gets its own future design doc |
| Pack API home | On the site (Vercel/Neon), independent of the daemon uptime |
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

The site holds the community infrastructure. The daemon holds the planning
infrastructure. Share links and galleries never depend on the VPS status.

Flow: `author (Plan/Studio publish button, or /publish upload) → pack API →
DB+Blob → capability link → friends (Nav/Plan, no account)`.

## Pack model

One `packs` table serves both kinds: `id`, `owner_id`, `type`
(`ride`|`scheme`), `name`, `slug`, `visibility`, `share_token`,
`folder_id?`, `current_version`, timestamps. Each upload adds a
`pack_versions` row (`version`, `blob_url`, `size`, `checksum`, extracted
metadata: distance/region for rides, colours for schemes, a preview image).
Pages and links always serve `current_version` — **links survive version
bumps**.

Visibility:

- **private** — the owner only. The default on upload.
- **unlisted** — each person with `dingodirt.com/p/<share_token>` (an
  unguessable capability URL) can view and download the pack. It is not
  listed anywhere.
- **public** — also listed in `/rides` or `/schemes`; gets the alias
  `/rides/<slug>` etc.

Downloads always stream through the API (the blob URLs are never exposed).
Thus a change back to private kills the link immediately. **Retract** = a
soft delete; we keep the blob for 30 days. **Folders**: `folders`
(`owner_id`, `parent_id`, `name`), nestable, dashboard-only organization.
There is no folder-level sharing (a later "collections" feature can layer on
without rework).

**App contract:** *Ride it* → `nav.dingodirt.com/?dl=<capability-url>`;
`?scheme=<capability-url>` likewise. Nav/Studio need only CORS-friendly
fetches, which the API provides.

## Auth & membership

Auth.js (NextAuth v5), Google + Microsoft providers. The first sign-in
creates a `users` row. The session cookie sits on `.dingodirt.com` — one
login for the site and Plan.

Roles come from the allowlist table (email → role):

- **visitor** — signed in, not allowlisted: can browse public content only.
- **member** — can publish / version / retract / set visibility on own
  packs; gets the dashboard.
- **admin** — also manages the allowlist and the waitlist, and can hide or
  delete any pack (the moderation path).

**Waitlist:** non-members see *Join the waitlist* — an email field, *where
did you hear about dingodirt?* (Facebook group / a mate / other), and the
mate's email if referred (the vouch is the approval signal). It also has an
**optional** "you and your bike" photo (community flair, deliberately not
identity proof). We examined and rejected a mandatory face photo: it is
unverifiable, high-friction, and a privacy liability. Cloudflare Turnstile
protects the form. The admin approves → the person is allowlisted.

**Publish buttons:** Plan (the same parent domain) POSTs with the shared
cookie. Studio (GitHub Pages) opens a `dingodirt.com` popup and hands over
the pack via `postMessage`. The popup confirms and uploads under the site
session.

## Pages

- `/` — what Dingo is; the Plan/Nav/Studio cards; *Watch the demo* →
  `demo.`; the Facebook group link; a strip of recent public packs.
- `/rides`, `/schemes` — the public galleries: preview, name, author;
  distance/region (rides) or colour swatches (schemes); newest first; a
  simple name/author search.
- `/p/<token>` — the pack page (the shareable unit): preview, metadata, the
  primary action (*Ride it* / *Plan with it* / *Remix in Studio*), *Copy
  link*.
- `/dashboard` — the member's pack tree (folders): a visibility toggle,
  version, downloads, copy link, update, retract.
- `/publish` — drag-and-drop upload → validation → the pack page with the
  link ready.
- `/admin` — waitlist approvals, the allowlist editor, all-packs moderation.

Look & feel: map-forward, dark-friendly, a sibling of the apps (optionally
themed by the default `.dingoscheme` — cute, not v1-blocking).

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/packs` | member | A new pack, or a new version (same name+owner → bump) |
| `GET /api/packs/:token` | capability | Metadata for pages and apps |
| `GET /api/packs/:token/download` | capability | Stream the zip; CORS open; count the download |
| `PATCH /api/packs/:id` | owner | Visibility, rename, description, folder |
| `DELETE /api/packs/:id` | owner/admin | Retract (a soft delete) |
| `GET /api/gallery?type=` | none | The public packs |
| `POST /api/waitlist` | Turnstile | Join the waitlist |
| `/api/admin/*` | admin | The allowlist, the waitlist, moderation |

**Upload validation** (we never store invalid content; rejections use plain
messages): not a zip, over the size cap (~50 MB), a missing or unparseable
`bundle.json`/`scheme.json`, an unsupported `schemaVersion`, a name
collision with another member's pack.

**Failure behavior:** a bad or retracted token → a friendly "no longer
shared" page, never a raw 404. Downloads complete or error — the API never
serves half a file. Rate limits apply to uploads (per member) and to the
waitlist (per IP).

## Analytics

Vercel Analytics, private — visitors by country is the v1 "users per
country". The download counts live in the DB and show to the pack owners.
There are no public stats and no extra cookies.

## Testing

1. **Upload validation** — fixture zips: a good ride/scheme, truncated,
   oversized, a bad manifest, a wrong `schemaVersion`, collisions.
2. **Capability semantics** — a private link fails; an unlisted link works
   but stays unlisted; a change back to private kills the link; retract →
   the friendly page; a version bump serves the new bytes at the same link.
3. **Auth boundaries** — a non-member cannot publish; a member cannot touch
   another member's pack; an admin can.
4. **App contract smoke** — before a release, real Nav fetches a fixture
   pack on a preview deploy via `?dl=`.

## Rollout (each step useful alone)

1. The site skeleton + landing + auth + waitlist
2. The pack service: upload, dashboard, visibility, capability links
   (Dave's story end-to-end via `/publish`)
3. Galleries + pack pages
4. The Studio/Plan publish buttons
5. Admin polish: approvals, moderation, download stats

Until the daemon's multi-user work lands, hosted Plan is the one gap in the
story. Authors fall back to a pack export and `/publish` — everything else
is unchanged.

## Deferred (YAGNI'd)

The forum (`forum.` reserved), profiles beyond a display name,
comments/ratings, events/writeups/news, a public stats page, shareable
folders/collections, teams, email notifications, search beyond name/author —
we wait for actual users to ask.

**White-label community sites (noted 2026-08-03, future direction):** offer
trail communities their own branded mini-site, in the mould of ad-hoc trail
sites like the GOAT (Great Oz Adventure Trail) Google Site. They get their
name, their colours (a `.dingoscheme` that doubles as the site theme), and
their curated packs and pages. The dingodirt pack service powers it
underneath (e.g. `goat.dingodirt.com` or a custom domain). The pack model
already fits (folders/collections per community, capability links). What it
adds is multi-tenant theming + curated content pages. Revisit this when a
second real community wants in.

## Monetization (direction, not commitment — noted 2026-08-03)

The working idea: planning is free, privacy is paid ("pay for privacy", the
old GitHub-private-repos model). The assessment from the 2026-08-03
discussion:

**What works.** Free users default to public, which seeds the galleries —
every free user enriches the commons. And genuine privacy needs skew
commercial (tour operators, event organizers who hide a route until race
day, guides who protect loops) — these are the users with a willingness to
pay.

**Known tensions.**

- *An inverted cost structure:* hosted Plan (daemon + PostGIS + VPS +
  per-user libraries) is the expensive product; private packs cost ~nothing.
  Users must understand the subscriptions as funds for Plan's infra.
- *Unlisted is the leak:* the core "pack for friends" flow runs on unlisted
  links, which are 95% of private use. A paywall on unlisted kills the Dave
  story. A free unlisted tier thins the privacy paywall. The resolution:
  gate **scale**, not the toggle.
- *Private tracks ≠ private packs:* private tracks are really a hosted-Plan
  seat. Price that as Plan tiers, which maps the price to the cost honestly.

**Sketched tiers (for when the community outgrows free-for-all):**

- **Free** — public packs, a few active private/unlisted packs, basic
  planning.
- **Paid individual** — unlimited private/unlisted packs, an own Plan
  library (Strava sync, heatmap contribution), folders/collections.
- **White-label (B2B)** — the branded community sites (above); likely the
  strongest revenue line — fewer, larger, and less awkward than charges to
  mates.

**Now:** nothing is gated. The crew allowlist doubles as grandfathering. The
schema takes tiers without rework (a `tier` column on users when needed).

## The validated user story ("Dave")

Dave hears of dingodirt in the Facebook group. He joins the waitlist ("Steve
invited me") and is approved. He signs into hosted Plan with Google and
builds Sunday's route. He taps **Publish** (no file touches his machine).
The pack appears private in his dashboard.

He flips it to **unlisted** and copies `dingodirt.com/p/x7Kq…`. He pastes
the link in the group chat. His mates tap it and hit **Ride it**. Nav
downloads the pack offline-ready — no accounts.

The route changes on Thursday: he re-publishes, the same link serves a
silent v2. After a great ride, he flips the pack to **public**, and it
appears in `/rides`. Rained out instead? **Retract** → the link shows "no
longer shared."
