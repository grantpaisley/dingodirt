# Planning mode — group trip planning on dingodirt.com

*2026-08-07. Prompted by the failed publish of Flinders2026 (59 candidate
tracks, several 200–2,200 km). Designed with a working prototype against the
real Flinders2026 data.*

## Problem

A big-trip pack has two lives. While the group is **deciding** (which tracks,
which nights where), nobody needs offline tiles — they need a shared,
high-level view of all candidates and a way to register opinions. Only once
tracks are chosen does the normal detailed pack (tiles, turn cues, corridor)
make sense — and then only for the chosen subset, possibly split by day.

Flinders2026 exposed both halves:

1. **The publish transport is broken for real packs.** Publishing now goes
   daemon → `POST dingodirt.com/api/packs`, a Vercel serverless route with a
   hard 4.5 MB request-body cap. Every existing pack is 8–43 MB. Vercel's 413
   is non-JSON, so the daemon surfaces a generic "publish failed". (Older
   packs shipped via the retired git path, which is why they ever worked.)
2. **A 59-track, four-layer pack is the wrong artefact anyway.** The tile
   corridor for 59 long desert routes is enormous; even the pre-build size
   estimate chokes. The deciding phase should never build tiles at all.

## The workflow (three phases)

1. **Share candidates** — Grant publishes a lightweight *planning pack* from
   Plan; mates open an unlisted link on dingodirt.com in any browser. No Nav
   install, no account, no unlock.
2. **Group selection** — mates vote Yes/Maybe/No per track (and on existing
   accommodation marks) with short comments; tallies flow back into Plan.
3. **Detailed packs** — Grant trims to the winners and publishes normal ride
   packs, a day/leg at a time.

## Decisions made (with rationale)

- **Site web view, not a stripped pack** — mates review in the browser on
  dingodirt.com, not in Nav. Avoids the Nav unlock/login friction entirely.
- **Votes/reactions per track**, not view-only and not full group editing.
- **Identity = name + unlisted link.** First vote prompts "Who are you?";
  the name lives in `localStorage`. The share link is the access control.
  Anyone with the link can vote under any name — acceptable for a mates
  group. Consequence: planning packs are *unlisted or public*; a true
  "private" (invited-only) tier would require mate accounts. Punted.
- **Accommodation**: existing pack marks are shown and votable; mates cannot
  drop new pins in v1.
- **Authentication exists in exactly one place**: Grant's existing `ddt_`
  API token (daemon ↔ site), used to publish the planning doc and pull votes
  back. Mates never authenticate.

## Planning doc

The planning pack's blob is a JSON file (`.dingoplan`): pack meta, per-track
simplified geometry + metadata (km, grade, region, kind), and the pack's
marks. Measured on Flinders2026 at tier-10 simplification: **313 KB for all
59 tracks** — it sails under the 4.5 MB cap, so planning publish works today
with no transport fix.

## Site: storage, API, page

**Table `pack_feedback`**: `id, pack_id, item_type ('track'|'mark'),
item_id, voter_name (≤24), kind ('vote'|'comment'), value, updated_at`.
Votes upsert on `(pack_id, item_type, item_id, voter_name)`; re-voting the
same value deletes (toggle). Comments append (≤200 chars).

**API** under `/api/packs/[token]/feedback`:

- `GET` — votes + comments grouped by item. Public; the share token is the
  gate; plan-type packs only.
- `POST` — `{itemType, itemId, name, vote?|comment?}`. Validates the item
  exists in the stored planning doc, enforces field caps, per-IP rate limit
  (same pattern as the publish route). No auth.

**Page**: `/p/[token]` detects `type === 'plan'` and renders the planning UI
as a client component (the site's first interactive map — MapLibre + the
shared R2 PMTiles once `tiles.dingodirt.com` is deployed). Votes fetched on
load, on focus, and every ~30 s. `validate-pack.ts` learns the `plan` type:
parses, has tracks, ~5 MB cap.

### Page UI (validated via prototype)

- Two panes: sortable track list (most wanted / name / distance / needs my
  vote) + map with all tracks colour-coded by group verdict (liked green,
  maybe amber, vetoed faded, unvoted grey). Marks with their icons, votable.
- Per-row: name, km, region/grade, Yes/Maybe/No, running tally, comments.
- Header rollup: "32 tracks liked (11,333 km) · 17 vetoed · 10 undecided".
- Map click ↔ list row sync both ways.
- **Selected track must be unmistakable**: ~3× normal width over a wide
  contrasting casing, full opacity (prototype: 9 px line in 13 px white
  casing vs 2.2 px normal). The same treatment is wanted in Plan itself
  (separate task).
- **Do not re-sort the list when a vote lands** — rows jump under the
  cursor. Hold order until the user changes sort or reloads (prototype got
  this wrong; the real page must not).
- Verdict rule: majority among voters; `no` wins ties over `maybe`;
  `yes` ≥ `maybe` reads as yes.

## Daemon and Plan

- **`publish_plan`** variant beside the existing publish. Skips
  `build_dingonav` entirely (no tiles, no corridor math — the part that
  choked). Pulls tier-10/14 simplified geometry via the existing ride
  simplification, attaches metadata + marks, ships JSON through the existing
  `upload_pack` + token path. The site plan pack is its own entry with its
  own share token; daemon stores `site_plan_id` alongside `site_pack_id` so
  a pack can have both a planning page and a real published pack.
- **Votes into Plan**: daemon proxies the feedback GET with the owner token.
  Pack detail pane gains per-ride verdict chips ("3 yes · 1 no"), inline
  mate comments, sort-by-verdict, and a bulk **"remove vetoed rides"**
  action. Planning re-publish is cheap; votes are keyed by ride id and
  survive re-publishes.

## Unbreaking full publish (needed regardless)

Vercel Blob **client uploads**: daemon requests an upload token from the
site (`handleUpload`, `@vercel/blob/client`, authed by the bearer token),
PUTs the bundle straight to Blob storage — no 4.5 MB body limit — then
calls a `complete` endpoint that fetches the blob server-side, runs the
existing validation, and writes the version row. Unbreaks every current
pack (Kandos = 43 MB).

## Day packs

Manual in v1: carve day/leg packs from the chosen tracks in Plan and publish
each as a normal ride pack — per-day corridors keep sizes sane. A "split
into N day-packs" helper is a later nicety. Even with the Blob fix, a
full-tile publish of all 59 candidates stays absurd on purpose: planning
mode is for deciding; full packs are for what you'll actually ride.

## Build order

1. Blob client-upload fix (small, unbreaks everything current).
2. Planning doc build + `plan` pack type + publish path (no votes yet —
   already a useful read-only share).
3. `pack_feedback` + voting UI on the planning page.
4. Vote tallies + "remove vetoed" in Plan.

## Prototype

A throwaway but fully interactive prototype (real Flinders2026 data, seeded
fake votes, OSM raster stand-in basemap) lives outside the repo; its UI is
the reference for the page section above.
