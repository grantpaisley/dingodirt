# Ride plans, living share links, DingoNav packs — design

*2026-07-13. Spans two repos: Dingo (this one) and DingoNav
(~/Desktop/Projects/DingoNav). Goal stated by Grant: "dingo central coast",
"dingo Menai", "dingo Singleton overnight" — each a single link a mate taps
once, app + data ready to go, several packs living side by side on their
phone, and when Grant revises a plan the mates just refresh.*

## The loop this enables

1. Grant baskets rides/plans → Share link "Menai" → WhatsApps it.
2. Mate taps → DingoNav opens (installs app shell offline on first visit),
   pack "Menai" persists on the phone alongside "Central Coast".
3. Thursday night Grant changes the plan and re-shares "Menai" → the SAME
   link now serves the new version (gist raw URLs track the latest revision).
4. Friday morning the mate taps ⟳ on the Menai pack → tracks replace under
   stable ids, their hand-added/removed turn cues re-apply automatically.

## Current state (audited 2026-07-13)

**Dingo** — `POST /api/export/share` (`crates/daemon/src/routes/export.rs`)
builds bundle.json, creates a NEW secret gist every call via `gh gist create`.
No record of past shares; re-sharing mints a new link, orphaning the old one.
bundle.json carries no identity: `{version, heatmapName, heatmap, tracks:
[{name, gpx}], skipped}` — no bundle name, no ride ids, no revision.

**DingoNav** — better than expected:
- Service worker caches the full app shell (fonts, sprites, styles,
  vendored maplibre/pmtiles/fflate); works fully offline after first visit.
- Everything imported persists in IndexedDB: tracks individually
  (`kind:'gpx'`), heatmap/basemap/hillshade as SINGLETONS (second bundle
  overwrites the first's heatmap + basemap), Strava tiles per-tile.
- `?bundle=` boot fetches, imports, persists — then strips and FORGETS the
  URL. No way to refresh.
- Track identity = content hash of the file (`gpx-<hash>-<npts>`), so a
  revised plan arrives as a duplicate track and the mate's cue edit overlay
  (`cueov-<trackId>`, removed[]/added[] — already designed to survive
  re-analysis) is lost.
- Track list is flat; "Clear" wipes the entire device.

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

`POST /api/export/share` behavior change: slug the requested name
(lowercase, `[a-z0-9-]`); if a `shares` row with that slug exists →
`gh gist edit <gist_id> <file>` (same filename, so the gist file is
replaced in place), bump `revision`, update `ride_ids`/`updated_at` →
the EXISTING raw URL now serves the new content. Otherwise `gh gist
create` as today and insert the row. Response gains
`{revision, updated: bool}`; `share_url` is unchanged in shape — raw gist
URLs without a revision sha always redirect to the latest revision, which
is the entire trick. `GET /api/export/shares` lists shares so the UI can
show what a name will update.

Web ExportDialog: after sharing, show "Updated existing link (v3) — mates
with the link just tap refresh" vs "New share link created".

### B. Bundle meta — identity travels with the data

bundle.json (both the gist share and the `.dingonav` zip) gains top-level
`bundleId` (the slug — human-meaningful, and same-name ⇒ same pack is the
semantics we want), `bundleName`, `revision` (share revision; 0 for plain
zip downloads), and each track gains `rideId` (the Dingo ride UUID).
`version` stays 2 — additive fields, old DingoNav builds ignore them.

### C. DingoNav — packs, refresh, stable ids

- **Pack records**: `{id: 'pack-<slug>', kind: 'pack', name, revision,
  sourceUrl, loadedAt}`. gpx + heatmap records gain a `pack` field. Legacy
  records (no pack) are adopted into an implicit "Loaded files" pack on
  boot. No IDB schema bump needed — new fields on existing store.
- **Heatmap per pack**: record id becomes `heatmap-<slug>` (legacy
  `heatmap` = the implicit pack). `S.heat` holds the ACTIVE pack's heatmap;
  selecting a track from another pack swaps it (cue caches already key on
  heat count so cues re-derive correctly).
- **Track list groups by pack**: header row = pack name + `v<revision>` +
  ⟳ refresh (when sourceUrl known) + ✕ remove-pack (granular delete;
  "Clear" stays as the full wipe).
- **`?bundle=` boot** stores the fetched URL in the pack record (still
  strips the query param). Re-tapping the same link = refresh, idempotent.
- **Refresh** (⟳, online): refetch sourceUrl → delete the pack's old
  gpx/heatmap records → re-import under the same pack. Same-link re-tap and
  ⟳ share one code path.
- **Stable track ids**: bundle tracks with `rideId` get id `ride-<uuid>`
  instead of the content hash. The cue edit overlay key (`cueov-<id>`)
  therefore SURVIVES plan revisions — the ±25 m at-metres tolerance in
  `cueRemoved` was built for exactly this drift. The cue ANALYSIS cache key
  must gain a geometry hash component (id no longer changes when geometry
  does), i.e. `cue6-<id>-<geomHash>-<heatCount>-<basePMKey>`.
- **Basemap stays a singleton** for now: recommend one wide extract (e.g.
  Sydney–Hunter) loaded once rather than per-pack corridor extracts;
  per-pack basemaps are a v2 (records are blob-keyed already, it's a
  selection-UI problem). Strava tiles already accumulate per-tile across
  packs; the zoom-range meta widens monotonically — acceptable.

### D. Later phases (designed here, not built now)

1. **Cue-overlay sync back to Dingo**: the overlay
   (removed[]/added[] per `ride-<uuid>`) is the edit journal from the
   earlier turn-points discussion. `POST /api/rides/{id}/cues/sync` when
   the phone is on home WiFi (needs the planned bearer-token auth first);
   file-export fallback for sneakernet. Dingo then bakes accepted cues
   into future bundle revisions.
2. **Plan geometry editing in Dingo**: revising a plan keeps its ride id
   (edit-in-place via the route drawer). With B+C above, edits then flow
   to mates automatically. Snap-to-ridden-tracks routing per the earlier
   plan-mode discussion.
3. **Zip-by-link** for full-offline packs (basemap included): host
   `.dingonav` zips on GitHub Releases or dingodirt.com; `?bundle=`
   already ships zip support via fflate — it only needs binary-capable
   hosting (gists are text-only).

## Build order

1. Dingo: `shares` migration + share create-or-update + bundle meta (A, B).
2. DingoNav: packs + refresh + stable ids + overlay/cache key changes (C).
3. Web ExportDialog copy for updated-vs-created (A).

Ships the whole loop in one pass; phases in D follow independently.
