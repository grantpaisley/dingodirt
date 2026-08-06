# dingodirt open-source pivot — public project, open community, tiny packs

*Design, 2026-08-03. Brainstormed and validated section-by-section. Amends
`2026-08-02-dingodirt-website-design.md`: supersedes its membership/waitlist
model and its monetization section; everything else (pack model, capability
links, galleries, stack) stands.*

## Decision summary

| Question | Decision |
|---|---|
| Open source scope | **Everything** — Dingo (daemon+Plan), DingoNav, Studio, DingoDirt site |
| License | **AGPL-3.0** across the board (service forks must share changes) |
| Code home | New **`dingodirt` GitHub org**; org Discussions = developer channel |
| Data | **Stays closed.** Open source ≠ open data: dingo-data / Dingo-processed / Strava-derived heat never publish; repos ship sample data |
| Site role | Hosted pack service stays as built — the community's sharing rail |
| Sign-up | **Open** (Google/Microsoft); waitlist/approval membership retired |
| Publishing | Anyone signed in: private/unlisted instantly (publisher's responsibility) |
| Public listings | **Pending → admin review → gallery**; per-user **trusted** flag skips review |
| Route safety | Terms (publisher affirms right to share) + rider notice on ride pages + Report button + review queue + takedown |
| Author v1 path | **Self-install Plan** (docker-compose); hosted multi-user Plan later, now optional not critical path |
| GPX→pack without Plan | **Client-side pack maker page** (`/make`) — browser-only, ships after shared tiles exist |
| Tile strategy | **Shared PMTiles, tiny packs**: regional basemap+hillshade hosted once; packs reference a corridor, don't embed tiles. No aerial imagery, ever |
| Sustainability | Free for everyone; donations (Sponsors/Ko-fi) for hosting; AGPL-compatible paid services (white-label, managed hosting) noted as future-possible. Replaces the monetization sketch |

## Accounts, moderation & route safety

Sign-in creates a full account; everyone can publish. Roles: **user**
(default — private/unlisted instant, public requests queue), **trusted**
(public goes live instantly; granted after a few good packs, revocable),
**admin** (review queue, trusted flags, hide anything, reports).

Flipping a pack public → `pending`: the link keeps working like unlisted,
but the pack isn't listed until one-click approval; reject returns it to
unlisted with a short reason. Private/unlisted packs are private
correspondence — like emailing a GPX — unmoderated by design.

Safety layers for problematic routes (private property, illegal trails):
terms of use (publisher affirms right to share; platform + takedown),
rider notice on every ride pack page (*check land access and local rules —
ride at your own risk*), Report button (Turnstile-protected) on public pack
pages, pre-publication review for the galleries.

## Site changes

- **Landing**: open-source reframe — three doors: **Ride** (galleries → Nav),
  **Share** (sign in, publish), **Build** (GitHub org, self-host). GitHub
  link in header/footer.
- **`/get-involved`** (replaces `/join`): riders → Facebook; developers →
  GitHub org + Discussions; authors → publish. Donations link.
- **`/terms`**: publisher responsibility, rider notice, takedown contact.
- **`/self-host`**: clone, docker-compose daemon+PostGIS, bring your own
  data; what self-hosting is and isn't needed for. (Ships with the org flip.)
- **`/make`** (after shared tiles): drop GPX → preview on shared basemap →
  marks → publish or download. Client-side only.
- Pack pages: rider notice (rides), Report button, "Share your own rides →"
  nudge when signed out.

Schema delta: `pending` visibility state; `allowlist` → trusted/admin flags;
`waitlist` retired; new `reports` table. Turnstile moves waitlist → report.

## Outside the site repo (recorded here, designed in their own docs)

- **Pack format v2 / shared tiles** (Nav-side design doc): packs carry
  route/marks + tile-source URL + corridor bbox instead of embedded tiles
  (KBs instead of tens of MBs; tiles dedupe across packs; blob costs become
  negligible). **DingoNav needs updating to retrieve tiles**: on pack
  install, range-request the corridor's tiles from the shared PMTiles
  archive and cache them for offline; keep the embedded-tile path for
  existing packs. Studio's exporter follows the same format.

  **Aerial imagery — personal layer, never pack content.** "No aerial"
  applies to packs and the shared tile archive only. Plan and Nav gain a
  per-device *aerial source* setting (tile URL template + key): a layer
  toggle switches basemap ↔ aerial, and Nav corridor-caches aerial tiles
  locally for offline use, same mechanism as basemap corridors. Imagery
  never ships in a pack or through dingodirt's storage — sizes stay tiny,
  provider licensing stays clean. (NSW Six Maps imagery is CC BY 4.0 — a
  comfortable default source for the home turf.)
- **GitHub org migration**: create org, scrub history for secrets, add
  LICENSE (AGPL-3.0) / CONTRIBUTING / sample data per repo, enable
  Discussions, then flip public.
- **Multi-user daemon design**: still pending; self-hosting makes it
  optional rather than the only author path.

## Rollout

1. Site rework: schema + moderation + pages (deployable immediately)
2. GitHub org public flip + `/self-host`
3. Shared PMTiles archive + pack format v2 + Nav corridor fetcher
4. `/make` pack maker
5. Hosted multi-user Plan (per its own design, someday)

## Testing adds

Pending semantics (public request ≠ listed until approved; trusted skips;
reject → unlisted; pending link behaves like unlisted), report flow,
existing capability tests unchanged.

## User stories (validated)

**Dave (author):** signs in — no waitlist — publishes via Plan on his own
machine (or `/publish` drag-and-drop; later `/make`), pack starts private,
flips to link for the group chat instantly, flips public → your one-click
review → gallery; after a few good packs you mark him trusted. Re-upload
bumps the version on the same link; Report + hide handle problems.

**Lisa (rider):** taps Dave's link in the group chat — pack page with route
preview and the land-access notice — **Ride it** → Nav offline on her
phone. Never signs in, never hits a wall; browses `/rides` on a wet week
and tries a scheme. The only thing gated is publishing.
