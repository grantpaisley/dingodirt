# Packs — persisted, refreshable share bundles

*2026-07-15 — validated in brainstorming session*

## Problem

Today, a share is a one-time artifact. It is a `.dingonav` file that the system pushes to the `DINGO_SHARE_REPO` GitHub repo. The recipe that made the share holds the rides, the layers, and the privacy setting. The system discards this recipe at publish time. Thus you cannot refresh, edit, or inspect a share. You can only list it by filename and delete it.

When you change a bundle many times before a trip, the repo fills with near-duplicate files. Nine Menai files on 2026-07-15 showed this problem.

## Concepts

| Concept | What it is | Persistence |
|---|---|---|
| **Track (ride)** | The source data | `rides` table (unchanged) |
| **Basket** | A temporary scratch selection — the shopping cart | UI state only (unchanged) |
| **Pack** | A named, saved recipe: an *ordered* list of ride ids + layer options + a description | New `packs` / `pack_rides` tables |

A **share is not a separate object**. A share is the published state of a pack (a slug + a published-at time). "Dingo Pack" is the user-facing name (you *pack* for a trip; dingoes travel in packs). "Bundle" stays only in the wire format (the `.dingonav` internals and the legacy `?bundle=` param).

We made these decisions:

- **Static membership.** A pack pins explicit ride ids. A refresh renders those exact rides again with the current data. A refresh also gets the current tiles again. You add new rides in the area manually. You can add or remove tracks as part of a refresh session. We keep room for a future "auto-include area" rule, but we do not build it.
- **Ordered tracks.** You can drag the list to sort it. `tracks[0]` is the default track that DingoNav auto-selects on load.
- **Live short links.** The link is `{nav_base}?b={slug}`. DingoNav resolves the slug to the raw file at HEAD of the shares repo. A refresh applies to links that you already sent (near 5 min CDN lag). This link also works as the URL shortener. No service is necessary.
- **Slug frozen at first publish.** You can change the display name freely after the first publish. The link never breaks. To get a new slug, delete the pack and share it again. A collision causes a 409 and a rename prompt (no auto-UUID suffixes).
- **Shares require a pack; plain exports stay one-off.** When you publish a link, you always go through a named pack. A zip export or a destination export from the basket stays one-time. The detail pane of a pack also has an export function.
- **Orphans are read-only.** Some repo files match no pack (shares from before packs). These files list with link and delete functions only.

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

A published pack is stale in two cases. Case one: `updated_at > published_at`. Case two: the row of a member ride changed after `published_at`.

## Backend API (`/api/packs`)

The publish function uses the existing `share_via_repo` machinery again. This machinery builds the `.dingonav` file, does a `gh api` PUT, and replaces a file with the same name.

- `GET /api/packs` — returns the id, name, description, slug, published_at, published_bytes, ride count, and a computed `stale` flag. The route appends repo files that match no slug as `orphan: true` (link and delete functions only).
- `POST /api/packs` — creates a draft from the basket. You give the name, the ordered ride_ids, and the layers.
- `PATCH /api/packs/{id}` — changes the name, the description, the layer toggles, and the full ordered ride array. The route uses replace semantics. There are no add or remove deltas.
- `POST /api/packs/{id}/publish` — builds and uploads `shares/{slug}.dingonav`. The first publish freezes the slug from the current name (409 if the slug is taken). Each call after that is a refresh. The route returns the live link. The route embeds the `description` in the bundle JSON.
- `DELETE /api/packs/{id}?unpublish=true` — deletes the row. The flag also deletes the repo file.

**Refresh-all is client-orchestrated.** The UI walks the stale packs one at a time, with a spinner or an error on each row. (The GitHub contents API causes sha-conflict commits when calls run in parallel.) We remove the old gist-based sharing of tracks only. There is one publish path.

## Web UI

The list pane gets a fourth view: `Tracks | Basket | Places | Packs`.

A pack row shows a **↻ refresh icon column**, the name, a 🔗 icon if published, the size, and the track count. The refresh icon shows a dot when the pack is stale. The icon shows a spinner while the publish runs. The icon is red on an error. The icon is disabled for drafts and orphans. The pane header has a **Refresh All** button. This button is enabled when one or more published packs are stale.

When you select a pack, the UI sets `selectedIds` to the ride ids of the pack. The map, the graph, and the stats then light up through the existing plumbing. The map flies to the combined bbox. The right pane changes to **PackDetail**:

- An editable name and a description. Once the pack is published, the pane shows the slug, the live link, and a Copy button.
- An ordered track list. Drag a row to change the order. The first row has a "default" badge. The ✕ button removes a track. A hover highlights the track on the map. Skipped rides (superseded rides or rides with no geometry) show greyed with a warning icon.
- An "Add selected tracks" button appends the current basket.
- Layer checkboxes with a live size estimate (uses `/api/export/estimate` again).
- Actions: Publish/Refresh · Export… (a one-time zip or destination export) · Delete.

The basket view gets a "Save as pack…" function. The name field starts with the `<suburb> <date>` default. The ExportDialog loses its share tab.

## DingoNav (separate repo)

- Resolve `?b=<slug>` →
  `https://raw.githubusercontent.com/<shares repo>/HEAD/shares/<slug>.dingonav`
  (the shares repo is a build-time constant). The legacy `?bundle=<url>` stays.
- Auto-select `tracks[0]` on load. Show the pack description.
- On a 404, show "this pack was removed". Then fall back to the local cached copy. Keep or add a re-download control to force-pull a fresh copy at the trailhead.

## Edge cases

- Superseded rides and rides with no geometry: the publish skips them and reports them (the existing behavior). The UI shows them greyed. The UI never makes the pack smaller without a report.
- Slug collision: the route returns a 409, and the UI prompts for a rename.
- Refresh-all partial failure: the failed row turns red, the walk continues, and a summary toast shows.
- `gh` missing or `DINGO_SHARE_REPO` unset: the pane header shows a 501-with-hint message.

## Testing

Route tests: pack CRUD, an ordering round-trip, the slug freeze after a rename, and the stale computation. Do a manual end-to-end test on `samples/`: create → publish → open the live link in DingoNav → reorder → refresh → make sure the link serves the new order and the default track.

## Build order

1. Migration + `/api/packs` CRUD
2. Publish/refresh endpoint + orphan merge
3. Packs view + PackDetail; ExportDialog share-tab removal
4. DingoNav: `?b=`, default track, description
