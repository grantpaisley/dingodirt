# Ride plans, living share links, DingoNav packs — design

*2026-07-13. This design covers two repos: Dingo (this one) and DingoNav
(~/Desktop/Projects/DingoNav). Grant gave the goal: "dingo central coast",
"dingo Menai", "dingo Singleton overnight". Each is one link that a mate
taps one time. The app and the data are then ready. More than one pack can
live on the phone at the same time. When Grant changes a plan, the mates
only refresh.*

## The loop this enables

1. Grant puts rides and plans in a basket. He shares the link "Menai". He
   sends it on WhatsApp.
2. The mate taps the link. DingoNav opens. On the first visit, the app
   shell installs for offline use. The pack "Menai" stays on the phone
   next to "Central Coast".
3. On Thursday night, Grant changes the plan. He shares "Menai" again. The
   SAME link now serves the new version (raw gist URLs track the latest
   revision).
4. On Friday morning, the mate taps ⟳ on the Menai pack. The tracks
   replace under stable ids. The turn cues that the mate added or removed
   apply again automatically.

## Current state (audited 2026-07-13)

**Dingo** — `POST /api/export/share` (`crates/daemon/src/routes/export.rs`)
builds bundle.json. It creates a NEW secret gist on each call with
`gh gist create`. Dingo keeps no record of past shares. A re-share makes a
new link and orphans the old one. bundle.json has no identity:
`{version, heatmapName, heatmap, tracks: [{name, gpx}], skipped}` — no
bundle name, no ride ids, no revision.

**DingoNav** — the state is better than expected:
- The service worker caches the full app shell (fonts, sprites, styles,
  vendored maplibre/pmtiles/fflate). The app works fully offline after the
  first visit.
- Each imported item persists in IndexedDB. Tracks persist one by one
  (`kind:'gpx'`). The heatmap, the basemap, and the hillshade persist as
  SINGLETONS. A second bundle overwrites the heatmap and the basemap of
  the first bundle. Strava tiles persist per tile.
- The `?bundle=` boot fetches, imports, and persists the data. It then
  strips the URL and FORGETS it. There is no way to refresh.
- The track identity is a content hash of the file (`gpx-<hash>-<npts>`).
  A revised plan thus arrives as a duplicate track. The cue edit overlay
  of the mate (`cueov-<trackId>`, removed[]/added[] — already designed to
  survive re-analysis) is lost.
- The track list is flat. "Clear" wipes the entire device.

## Design

### A. Share identity in Dingo — living links

Migration `shares`:

```sql
CREATE TABLE shares (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,   -- pack key, derived from name
    gist_id     TEXT NOT NULL,
    gist_user   TEXT NOT NULL,
    ride_ids    UUID[] NOT NULL,
    revision    INT  NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`POST /api/export/share` gets a new behavior. Make a slug from the
requested name (lowercase, `[a-z0-9-]`). If a `shares` row with that slug
exists, run `gh gist edit <gist_id> <file>`. The filename stays the same,
so the edit replaces the gist file in place. Increase `revision`. Update
`ride_ids` and `updated_at`. The EXISTING raw URL then serves the new
content. If no row exists, run `gh gist create` as today and insert the
row. The response gains `{revision, updated: bool}`. The shape of
`share_url` does not change. Raw gist URLs without a revision sha always
redirect to the latest revision. This redirect is the entire trick.
`GET /api/export/shares` lists the shares, so the UI can show what a name
will update.

Web ExportDialog: after the share, show "Updated existing link (v3) —
mates with the link just tap refresh" or "New share link created".

### B. Bundle meta — identity travels with the data

bundle.json (both the gist share and the `.dingonav` zip) gains these
top-level fields: `bundleId` (the slug), `bundleName`, and `revision`. The
slug is human-meaningful. Same name ⇒ same pack — this is the semantics we
want. `revision` is the share revision, and it is 0 for plain zip
downloads. Each track gains `rideId` (the Dingo ride UUID). `version`
stays 2 — the fields are additive, and old DingoNav builds ignore them.

### C. DingoNav — packs, refresh, stable ids

- **Pack records**: `{id: 'pack-<slug>', kind: 'pack', name, revision,
  sourceUrl, loadedAt}`. The gpx and heatmap records gain a `pack` field.
  On boot, legacy records (no pack) go into an implicit "Loaded files"
  pack. No IDB schema bump is necessary — the new fields go on the
  existing store.
- **Heatmap per pack**: the record id becomes `heatmap-<slug>`. The
  legacy id `heatmap` is the implicit pack. `S.heat` holds the heatmap of
  the ACTIVE pack. When you select a track from another pack, the heatmap
  swaps. The cue caches already key on the heat count, so the cues
  re-derive correctly.
- **Track list groups by pack**: the header row shows the pack name,
  `v<revision>`, ⟳ refresh (when sourceUrl is known), and ✕ remove-pack.
  Remove-pack is a granular delete. "Clear" stays as the full wipe.
- **`?bundle=` boot** stores the fetched URL in the pack record. It still
  strips the query param. A re-tap on the same link is a refresh, and it
  is idempotent.
- **Refresh** (⟳, online): refetch the sourceUrl. Delete the old gpx and
  heatmap records of the pack. Re-import under the same pack. The
  same-link re-tap and ⟳ share one code path.
- **Stable track ids**: bundle tracks with `rideId` get the id
  `ride-<uuid>` instead of the content hash. The cue edit overlay key
  (`cueov-<id>`) thus SURVIVES plan revisions. We built the ±25 m
  at-metres tolerance in `cueRemoved` for exactly this drift. The cue
  ANALYSIS cache key must gain a geometry hash component, because the id
  no longer changes when the geometry does. The key becomes
  `cue6-<id>-<geomHash>-<heatCount>-<basePMKey>`.
- **Basemap stays a singleton** for now. We recommend one wide extract
  (for example Sydney–Hunter), loaded one time, instead of corridor
  extracts per pack. Basemaps per pack are a v2 item. The records are
  blob-keyed already; the problem is only in the selection UI. Strava
  tiles already accumulate per tile across packs. The zoom-range meta
  widens monotonically — this is acceptable.

### D. Later phases (designed here, not built now)

1. **Cue-overlay sync back to Dingo**: the overlay (removed[]/added[] per
   `ride-<uuid>`) is the edit journal from the earlier turn-points
   discussion. Call `POST /api/rides/{id}/cues/sync` when the phone is on
   the home WiFi. This needs the planned bearer-token auth first. A
   file-export fallback covers sneakernet. Dingo then bakes accepted cues
   into future bundle revisions.
2. **Plan geometry editing in Dingo**: when you revise a plan, the plan
   keeps its ride id (edit-in-place through the route drawer). With B and
   C above, the edits then flow to the mates automatically.
   Snap-to-ridden-tracks routing follows the earlier plan-mode
   discussion.
3. **Zip-by-link** for full-offline packs (basemap included): host the
   `.dingonav` zips on GitHub Releases or dingodirt.com. `?bundle=`
   already ships zip support via fflate. It only needs binary-capable
   hosting (gists are text-only).

## Build order

1. Dingo: `shares` migration + share create-or-update + bundle meta (A, B).
2. DingoNav: packs + refresh + stable ids + overlay/cache key changes (C).
3. Web ExportDialog copy for updated-vs-created (A).

This order ships the whole loop in one pass. The phases in D follow
independently.
