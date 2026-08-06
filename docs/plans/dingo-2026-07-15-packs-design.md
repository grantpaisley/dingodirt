# Packs — persisted, refreshable share bundles

*2026-07-15 — validated in brainstorming session*

## Problem

A share today is a fire-and-forget artifact: a `.dingonav` file pushed to the
`DINGO_SHARE_REPO` GitHub repo. The recipe that produced it (which rides, which
layers, what privacy setting) is thrown away at publish time, so a share can't
be refreshed, edited, or even inspected — only listed by filename and deleted.
Iterating on a bundle before a trip litters the repo with near-duplicates
(nine Menai files on 2026-07-15 taught us this).

## Concepts

| Concept | What it is | Persistence |
|---|---|---|
| **Track (ride)** | Source data | `rides` table (unchanged) |
| **Basket** | Transient scratch selection — the shopping cart | UI state only (unchanged) |
| **Pack** | Named, saved recipe: an *ordered* list of ride ids + layer options + description | New `packs` / `pack_rides` tables |

A **share is not a separate object** — it is a pack's published state (slug +
published-at). "Dingo Pack" is the user-facing name (you *pack* for a trip;
dingoes travel in packs). "Bundle" survives only in the wire format
(`.dingonav` internals, legacy `?bundle=` param).

Decisions made:

- **Static membership.** A pack pins explicit ride ids. Refresh re-renders
  those exact rides with current data and re-fetches current tiles; new rides
  in the area are added manually (tracks can be added/removed as part of a
  refresh session). Room left for a future "auto-include area" rule, not built.
- **Ordered tracks.** The list is drag-sortable; `tracks[0]` is the default
  track DingoNav auto-selects on load.
- **Live short links.** `{nav_base}?b={slug}` — DingoNav resolves the slug to
  the raw file at HEAD of the shares repo. Refresh propagates to links already
  sent (≈5 min CDN lag). This doubles as the URL shortener; no service needed.
- **Slug frozen at first publish.** Display name freely editable afterwards;
  the link never breaks. New slug = delete + re-share. Collision → 409 and a
  rename prompt (no auto-UUID suffixes).
- **Shares require a pack; plain exports stay one-off.** Publishing a link
  always goes through a named pack. Zip / destination export from the basket
  stays fire-and-forget; a pack's detail pane also offers export.
- **Orphans are read-only.** Repo files with no matching pack (pre-packs
  shares) list with link/delete only.

## Data model

```sql
CREATE TABLE packs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,        -- display name, freely editable
  description       TEXT NOT NULL DEFAULT '',
  slug              TEXT UNIQUE,          -- frozen at first publish; NULL = never shared
  include_tracks    BOOL NOT NULL DEFAULT true,
  include_heatmap   BOOL NOT NULL DEFAULT false,
  include_strava    BOOL NOT NULL DEFAULT false,
  include_basemap   BOOL NOT NULL DEFAULT false,
  include_satellite BOOL NOT NULL DEFAULT false,
  include_hillshade BOOL NOT NULL DEFAULT false,
  privacy           BOOL NOT NULL DEFAULT true,
  heatmap_filters   JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- recipe edits
  published_at      TIMESTAMPTZ,          -- NULL = draft
  published_bytes   BIGINT
);

CREATE TABLE pack_rides (
  pack_id  UUID NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  ride_id  UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  position INT  NOT NULL,                 -- 0 = default track in DingoNav
  PRIMARY KEY (pack_id, ride_id)
);
```

Staleness = published pack where `updated_at > published_at` or any member
ride's row changed since `published_at`.

## Backend API (`/api/packs`)

Publishing reuses the existing `share_via_repo` machinery (build `.dingonav`,
`gh api` PUT, replace-on-same-name).

- `GET /api/packs` — id, name, description, slug, published_at,
  published_bytes, ride count, computed `stale`; repo files matching no slug
  appended as `orphan: true` (link/delete only).
- `POST /api/packs` — create draft from basket: name, ordered ride_ids, layers.
- `PATCH /api/packs/{id}` — rename, description, layer toggles, and the full
  ordered ride array (replace semantics; no add/remove deltas).
- `POST /api/packs/{id}/publish` — build + upload `shares/{slug}.dingonav`.
  First publish freezes slug from current name (409 if taken); subsequent
  calls are refresh. Returns the live link. `description` is embedded in the
  bundle JSON.
- `DELETE /api/packs/{id}?unpublish=true` — delete row; flag also deletes the
  repo file.

**Refresh-all is client-orchestrated**: the UI walks stale packs sequentially
(per-row spinner/error; GitHub contents API commits sha-conflict in parallel
anyway). Old gist-based tracks-only sharing is removed — one publish path.

## Web UI

List pane gains a fourth view: `Tracks | Basket | Places | Packs`.

Pack row: **↻ refresh icon column** (dot when stale, spinner while publishing,
red on error, disabled for drafts/orphans) · name · 🔗 if published · size ·
track count. Pane header: **Refresh All** (enabled when any published pack is
stale).

Selecting a pack sets `selectedIds` to its ride ids (map, graph, stats light up
via existing plumbing) and flies to the combined bbox. The right pane swaps to
**PackDetail**:

- Editable name + description (slug + live link + Copy shown once published)
- Ordered track list — drag to reorder, first row badged "default", ✕ remove,
  hover highlights on map; skipped rides (superseded/no geometry) greyed with
  a warning icon
- "Add selected tracks" appends the current basket
- Layer checkboxes with live size estimate (reuses `/api/export/estimate`)
- Actions: Publish/Refresh · Export… (zip/destination one-off) · Delete

Basket view gains "Save as pack…" (name pre-filled with the `<suburb> <date>`
default). ExportDialog drops its share tab.

## DingoNav (separate repo)

- Resolve `?b=<slug>` →
  `https://raw.githubusercontent.com/<shares repo>/HEAD/shares/<slug>.dingonav`
  (shares repo is a build-time constant). Legacy `?bundle=<url>` stays.
- Auto-select `tracks[0]` on load; show pack description.
- 404 → "this pack was removed" + fall back to locally cached copy; keep/add a
  re-download affordance to force-pull fresh at the trailhead.

## Edge cases

- Superseded / geometry-less rides: publish skips + reports (existing
  behavior); UI shows them greyed, never silently shrinks the pack.
- Slug collision: 409, prompt rename.
- Refresh-all partial failure: failed row red, walk continues, summary toast.
- `gh` missing / `DINGO_SHARE_REPO` unset: 501-with-hint in pane header.

## Testing

Route tests: pack CRUD, ordering round-trip, slug freeze after rename, stale
computation. Manual end-to-end on `samples/`: create → publish → open live
link in DingoNav → reorder → refresh → link serves new order + default track.

## Build order

1. Migration + `/api/packs` CRUD
2. Publish/refresh endpoint + orphan merge
3. Packs view + PackDetail; ExportDialog share-tab removal
4. DingoNav: `?b=`, default track, description
