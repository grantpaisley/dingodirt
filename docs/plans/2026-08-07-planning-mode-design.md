# Planning mode — group trip planning on dingodirt.com

*2026-08-07. The failed publish of Flinders2026 (59 candidate tracks, several 200–2,200 km) caused this design. We designed it with a working prototype against the real Flinders2026 data.*

## Problem

A big-trip pack has two lives. While the group **decides** (which tracks, which nights where), nobody needs offline tiles. The group needs a shared, high-level view of all candidates and a way to record opinions. The normal detailed pack (tiles, turn cues, corridor) makes sense only after the group chooses the tracks. Then the pack covers only the chosen subset, possibly split by day.

Flinders2026 showed both halves of the problem:

1. **The publish transport is broken for real packs.** The publish now goes
   daemon → `POST dingodirt.com/api/packs`. This is a Vercel serverless route with a hard 4.5 MB cap on the request body. Every existing pack is 8–43 MB. The 413 from Vercel is non-JSON, so the daemon shows a generic "publish failed" message. (Older packs shipped through the retired git path. That is why they worked at all.)
2. **A 59-track, four-layer pack is the wrong artefact anyway.** The tile
   corridor for 59 long desert routes is enormous. Even the pre-build size estimate chokes. The deciding phase must never build tiles at all.

## The workflow (three phases)

1. **Share candidates** — Grant publishes a lightweight *planning pack* from
   Plan. The mates open an unlisted link on dingodirt.com in a browser. They do not need a Nav install, an account, or an unlock.
2. **Group selection** — the mates vote Yes/Maybe/No on each track and on the existing accommodation marks. They can add short comments. The tallies flow back into Plan.
3. **Detailed packs** — Grant trims the pack to the winners. Then he publishes normal ride packs, one day or leg at a time.

## Decisions made (with rationale)

- **Site web view, not a stripped pack** — the mates review in the browser on
  dingodirt.com, not in Nav. This removes the Nav unlock and login friction fully.
- **Votes/reactions per track**, not view-only and not full group editing.
- **Identity = name + unlisted link.** The first vote prompts "Who are you?".
  The name lives in `localStorage`. The share link is the access control.
  A person with the link can vote under any name. This is acceptable for a group of mates. Consequence: planning packs are *unlisted or public*. A true "private" (invited-only) tier would need mate accounts. We punted on that.
- **Accommodation**: the page shows the existing pack marks, and the mates can vote on them. The mates cannot drop new pins in v1.
- **Authentication exists in exactly one place**: Grant's existing `ddt_`
  API token (daemon ↔ site). The token publishes the planning doc and pulls the votes back. The mates never authenticate.

## Planning doc

The blob of the planning pack is a JSON file (`.dingoplan`). The file holds the pack meta, the simplified geometry + metadata of each track (km, grade, region, kind), and the marks of the pack. We measured Flinders2026 at tier-10 simplification: **313 KB for all 59 tracks**. This is far under the 4.5 MB cap. Thus the planning publish works today with no transport fix.

## Site: storage, API, page

**Table `pack_feedback`**: `id, pack_id, item_type ('track'|'mark'),
item_id, voter_name (≤24), kind ('vote'|'comment'), value, updated_at`.
Votes upsert on `(pack_id, item_type, item_id, voter_name)`. A second vote with the same value deletes the vote (a toggle). Comments append (≤200 chars).

**API** under `/api/packs/[token]/feedback`:

- `GET` — returns the votes + comments grouped by item. The route is public. The share token is the gate. The route serves plan-type packs only.
- `POST` — `{itemType, itemId, name, vote?|comment?}`. The route checks that the item exists in the stored planning doc. The route applies the field caps and a per-IP rate limit (the same pattern as the publish route). There is no auth.

**Page**: `/p/[token]` detects `type === 'plan'` and renders the planning UI
as a client component. This is the first interactive map on the site — MapLibre + the shared R2 PMTiles, once `tiles.dingodirt.com` is deployed. The page fetches the votes on load, on focus, and about every 30 s. `validate-pack.ts` learns the `plan` type: the file parses, the file has tracks, and a cap near 5 MB applies.

### Page UI (validated via prototype)

- The page has two panes. Pane one is a sortable track list (most wanted / name / distance / needs my vote). Pane two is a map with all tracks colour-coded by the group verdict (liked green, maybe amber, vetoed faded, unvoted grey). The marks show with their icons, and the mates can vote on them.
- Each row shows the name, the km, the region/grade, Yes/Maybe/No, the running tally, and the comments.
- The header rollup shows: "32 tracks liked (11,333 km) · 17 vetoed · 10 undecided".
- A map click and a list row stay in sync, in both directions.
- **The selected track must be unmistakable**: about 3× the normal width over a wide
  contrasting casing, at full opacity (prototype: a 9 px line in a 13 px white
  casing vs 2.2 px normal). We want the same treatment in Plan itself
  (a separate task).
- **Do not re-sort the list when a vote lands** — the rows jump under the
  cursor. Hold the order until the user changes the sort or reloads. (The prototype got this wrong. The real page must not.)
- Verdict rule: the majority among the voters wins. `no` wins ties over `maybe`.
  `yes` ≥ `maybe` reads as yes.
- **Map type switcher** (v1): a corner control cycles topo / topo+hillshade /
  satellite — if the sources permit (the shared R2 tiles; satellite only if a
  publicly shareable source exists — the personal aerial set is not one).

### Naming (open idea, not acted on)

The new page possibly deserves the name **Plan** — planning actually happens there. Then the ride collection of the current Plan app becomes the **Library**. The cheap first step changes the user-facing copy only. Call the page "plan view". Call the collection of the app "library". Rename `apps/plan` later, and only if the vocabulary sticks.

## Daemon and Plan

- **`publish_plan`** is a variant beside the existing publish. It skips
  `build_dingonav` fully (no tiles, no corridor math — the part that
  choked). It pulls tier-10/14 simplified geometry through the existing ride
  simplification. It attaches the metadata + marks. It ships the JSON through the existing
  `upload_pack` + token path. The site plan pack is its own entry with its
  own share token. The daemon stores `site_plan_id` next to `site_pack_id`. Then one pack can have both a planning page and a real published pack.
- **Votes into Plan**: the daemon proxies the feedback GET with the owner token.
  The pack detail pane gets per-ride verdict chips ("3 yes · 1 no"), inline
  mate comments, a sort-by-verdict option, and a bulk **"remove vetoed rides"**
  action. A planning re-publish is cheap. The votes are keyed by ride id and
  stay through re-publishes.

## Unbreaking full publish (needed regardless)

Use Vercel Blob **client uploads**. The daemon requests an upload token from the
site (`handleUpload`, `@vercel/blob/client`, authed by the bearer token).
The daemon PUTs the bundle straight to Blob storage — there is no 4.5 MB body limit. Then the daemon
calls a `complete` endpoint. The endpoint fetches the blob server-side, runs the
existing validation, and writes the version row. This unbreaks every current
pack (Kandos = 43 MB).

## Day packs

This is manual in v1. Carve day or leg packs from the chosen tracks in Plan. Publish
each pack as a normal ride pack. Per-day corridors keep the sizes sane. A "split
into N day-packs" helper is a later nicety. Even with the Blob fix, a
full-tile publish of all 59 candidates stays absurd, on purpose. Planning
mode is for the decision. Full packs are for what you will actually ride.

## Build order

1. Blob client-upload fix (small, unbreaks everything current).
2. Planning doc build + `plan` pack type + publish path (no votes yet —
   this is already a useful read-only share).
3. `pack_feedback` + voting UI on the planning page.
4. Vote tallies + "remove vetoed" in Plan.

## Prototype

A throwaway but fully interactive prototype lives outside the repo. It uses the real Flinders2026 data, seeded fake votes, and an OSM raster stand-in basemap. Its UI is the reference for the page section above.
