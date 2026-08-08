# dingodirt open-source pivot — public project, open community, tiny packs

*Design, 2026-08-03. We brainstormed and validated it section by section. It
amends `2026-08-02-dingodirt-website-design.md`: it supersedes the
membership/waitlist model and the monetization section of that document.
Everything else (the pack model, capability links, galleries, stack)
stands.*

## Decision summary

| Question | Decision |
|---|---|
| Open source scope | **Everything** — Dingo (daemon+Plan), DingoNav, Studio, DingoDirt site |
| License | **AGPL-3.0** across the board (service forks must share changes) |
| Code home | A new **`dingodirt` GitHub org**; org Discussions = the developer channel |
| Data | **Stays closed.** Open source ≠ open data: dingo-data / Dingo-processed / Strava-derived heat never publish; the repos ship sample data |
| Site role | The hosted pack service stays as built — the sharing rail of the community |
| Sign-up | **Open** (Google/Microsoft); the waitlist/approval membership is retired |
| Publishing | Anyone signed in: private/unlisted instantly (the publisher's responsibility) |
| Public listings | **Pending → admin review → gallery**; a per-user **trusted** flag skips review |
| Route safety | Terms (the publisher affirms the right to share) + a rider notice on ride pages + a Report button + a review queue + takedown |
| Author v1 path | **Self-install Plan** (docker-compose); hosted multi-user Plan later, now optional, not the critical path |
| GPX→pack without Plan | A **client-side pack maker page** (`/make`) — browser-only, ships after the shared tiles exist |
| Tile strategy | **Shared PMTiles, tiny packs**: the regional basemap+hillshade is hosted once; packs reference a corridor and do not embed tiles. No aerial imagery, ever |
| Sustainability | Free for everyone; donations (Sponsors/Ko-fi) for hosting; AGPL-compatible paid services (white-label, managed hosting) noted as future-possible. This replaces the monetization sketch |

## Accounts, moderation & route safety

A sign-in creates a full account, and everyone can publish. The roles:
**user** (default — private/unlisted is instant, public requests queue),
**trusted** (public goes live instantly; granted after a few good packs,
revocable), and **admin** (review queue, trusted flags, hide anything,
reports).

When you flip a pack public, it goes to `pending`: the link continues to
work like unlisted, but the pack is not listed until a one-click approval.
A reject returns the pack to unlisted with a short reason. Private and
unlisted packs are private correspondence — like an email with a GPX —
unmoderated by design.

The safety layers for problematic routes (private property, illegal
trails): the terms of use (the publisher affirms the right to share;
platform + takedown), a rider notice on every ride pack page (*check land
access and local rules — ride at your own risk*), a Report button
(Turnstile-protected) on public pack pages, and pre-publication review for
the galleries.

## Site changes

- **Landing**: an open-source reframe — three doors: **Ride** (galleries →
  Nav), **Share** (sign in, publish), **Build** (GitHub org, self-host). A
  GitHub link goes in the header and the footer.
- **`/get-involved`** (replaces `/join`): riders → Facebook; developers →
  GitHub org + Discussions; authors → publish. A donations link.
- **`/terms`**: the publisher responsibility, the rider notice, the
  takedown contact.
- **`/self-host`**: clone, docker-compose daemon+PostGIS, bring your own
  data; what self-hosting is and is not needed for. (Ships with the org
  flip.)
- **`/make`** (after shared tiles): drop GPX → preview on the shared
  basemap → marks → publish or download. Client-side only.
- Pack pages: the rider notice (rides), the Report button, and a "Share
  your own rides →" nudge when signed out.

Schema delta: a `pending` visibility state; `allowlist` → trusted/admin
flags; `waitlist` retired; a new `reports` table. Turnstile moves from the
waitlist to the report.

## Outside the site repo (recorded here, designed in their own docs)

- **Pack format v2 / shared tiles** (a Nav-side design doc): packs carry
  the route/marks + the tile-source URL + the corridor bbox instead of
  embedded tiles. This gives KBs instead of tens of MBs. Tiles dedupe
  across packs, and the blob costs become negligible. **DingoNav needs an
  update to retrieve tiles**: on pack install, range-request the tiles of
  the corridor from the shared PMTiles archive and cache them for offline
  use. Keep the embedded-tile path for existing packs. The exporter of
  Studio follows the same format.

  **Aerial imagery — a personal layer, never pack content.** "No aerial"
  applies to packs and the shared tile archive only. Plan and Nav gain a
  per-device *aerial source* setting (tile URL template + key). A layer
  toggle switches basemap ↔ aerial. Nav corridor-caches the aerial tiles
  locally for offline use, with the same mechanism as the basemap
  corridors. Imagery never ships in a pack or through the storage of
  dingodirt — the sizes stay tiny, and the provider licensing stays clean.
  (NSW Six Maps imagery is CC BY 4.0 — a comfortable default source for
  the home turf.)
- **GitHub org migration**: create the org. Scrub the history for secrets.
  Add LICENSE (AGPL-3.0) / CONTRIBUTING / sample data per repo. Enable
  Discussions. Then flip public.
- **Multi-user daemon design**: still pending. Self-hosting makes it
  optional, not the only author path.

## Rollout

1. Site rework: schema + moderation + pages (deployable immediately)
2. GitHub org public flip + `/self-host`
3. Shared PMTiles archive + pack format v2 + Nav corridor fetcher
4. `/make` pack maker
5. Hosted multi-user Plan (per its own design, someday)

## Testing adds

Test the pending semantics (a public request is not listed until approved;
trusted skips; reject → unlisted; a pending link behaves like unlisted).
Test the report flow. The existing capability tests do not change.

## User stories (validated)

**Dave (author):** he signs in — no waitlist. He publishes via Plan on his
own machine (or `/publish` drag-and-drop; later `/make`). The pack starts
private. He flips it to a link for the group chat instantly. He flips it
public → your one-click review → the gallery. After a few good packs, you
mark him trusted. A re-upload bumps the version on the same link. Report +
hide handle problems.

**Lisa (rider):** she taps Dave's link in the group chat. She gets the pack
page with the route preview and the land-access notice. **Ride it** → Nav
offline on her phone. She never signs in and never hits a wall. She browses
`/rides` on a wet week and tries a scheme. The only gated thing is
publishing.
