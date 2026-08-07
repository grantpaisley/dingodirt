# List filtering with pills, folders, and labelsets

**Date:** 2026-08-07
**App:** Plan (left panel `ListPane`), server
**Status:** Design agreed, not yet implemented

## Summary

Replace the Plan left panel's ad-hoc filters (mode/class toggles, Layers ride
entries, focus mode) with a single faceted-filter model: a row of **pills**,
each pill one filter dimension (Type, Owner, Start/End/Touches location,
Folder, Has HR, Has Speed, Is loop, free-text search). Pills AND together;
values within a pill OR; dropdown value lists are faceted (narrowed, with
counts) by the other active pills. Add a user-managed **folder tree**
(single home per item) and derive pack attributes from member rides so packs
filter alongside tracks and routes.

## Decisions (with alternatives considered)

1. **Hybrid labelsets.** System dimensions are *virtual* — filter definitions
   over columns `rides` already has (`suburbs[1]` = start suburb, `end_*`,
   `owner_id`, HR/speed presence…). User-created groupings are *materialised*
   (folders now; labels tables later). Both are exposed through one
   "dimension" API shape so the UI cannot tell the difference.
   *Rejected:* all-virtual (no future user labelsets), all-materialised
   (duplicates column data, needs re-sync on re-geocode).
2. **Packs derive attributes from member rides**, cached on the pack row and
   recomputed on membership change. *Rejected:* geocoding pack geometry
   independently (drift), packs opting out of system dimensions
   (inconsistent UI).
3. **Folders: single-home tree.** `folders(id, name, parent_id)`, nullable
   `folder_id` on rides and packs. Multi-membership is what labels are for
   (future). Folders are type-agnostic — "GOAT NSW North" becomes an ordinary
   folder that happens to hold routes but could hold tracks. *Rejected:*
   folders-as-labels with a "default" folder (uniqueness constraint bolted
   onto a many-to-many; every move/count special-cases the default).
4. **Faceted-search semantics.** AND between pills, OR within a pill's
   checked values; a pill's dropdown shows only values matching the *other*
   active pills, with counts. *Rejected:* strict cascade (same results, more
   bookkeeping), full boolean builder (YAGNI; per-pill NOT can come later).
5. **v1 user labelling = folders only.** Labels/label_sets tables are
   designed (below) but not built. *Rejected for v1:* flat Tags set, full
   custom labelsets.
6. **Search is a pill.** A non-empty query becomes a pill and ANDs with the
   rest; multiple search pills allowed. Matches name, **original name (as
   loaded)**, description, suburbs/LGAs/region, folder name.
7. **Layers ride entries dissolve into pills.** "My rides / Other rides /
   Fabio…" becomes an **Owner** dimension pill. Heatmap stays in Layers as-is
   for now; heatmaps are not list items.
8. **Selection never mutates the list.** Clicking an item toggles selection
   (first click selects, second deselects — easy multi-select, no modifier
   keys). Selection drives highlight, detail pane, and map emphasis only.
   The list changes only when pills change. Focus mode's list replacement
   goes away.

## Data model

```sql
CREATE TABLE folders (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name      TEXT NOT NULL,
    parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,          -- manual sort within parent
    UNIQUE (parent_id, name)
);

ALTER TABLE rides ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE packs ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
```

- NULL `folder_id` = root ("Unfiled"). Deleting a folder cascades to child
  folders; items fall back to Unfiled (`SET NULL`), never deleted.
- **`collection` migration:** one-off migration creates a folder per distinct
  `collection` value and files those rides. The `collection` column stays as
  import provenance (survives re-downloads); the UI stops reading it, and
  imports drop new planned routes into the matching folder by name.

**Pack cached attributes** (mirroring rides):

```sql
ALTER TABLE packs ADD COLUMN
    state TEXT, region TEXT, lgas TEXT[], suburbs TEXT[],
    end_state TEXT, end_region TEXT, end_lga TEXT, end_suburb TEXT,
    has_hr BOOLEAN, has_speed BOOLEAN;
```

`recompute_pack_attributes(pack_id)`: union of member `suburbs[]`/`lgas[]`
(ordered by first encounter across members), start singles from the first
member, `end_*` from the last, booleans OR'd. Called from every
membership-changing path (add/remove ride, pack revision creation);
synchronous — it is cheap. One-off backfill for existing packs.

**Rides:** nothing new, except cache `has_hr`/`has_speed` booleans at ingest
if presence currently needs a segments join (check `ride_stats_columns` at
implementation time).

**Future (designed, not built):**

```sql
label_sets(id, name)
labels(id, label_set_id, name, parent_id)      -- hierarchies via parent, like folders
item_labels(item_type, item_id, label_id)      -- item_type: ride | pack
```

## Dimension registry and API

A server-side registry — one list of filter dimensions, each declaring how it
resolves. The UI never knows virtual from materialised.

| Dimension | Kind | Backing |
|---|---|---|
| Type | virtual, flat | track (`kind=recorded`) / route (`kind=planned`) / pack |
| Owner | virtual, flat | `owner_id` → owners |
| Start location | virtual, hierarchical | `suburbs[1]` + gazetteer (state → region → LGA → suburb) |
| End location | virtual, hierarchical | `end_*` columns |
| Touches | virtual, hierarchical | `suburbs[]` / `lgas[]` arrays (GIN-indexed) |
| Has HR / Has Speed / Is loop | virtual, boolean | cached booleans |
| Folder | materialised, hierarchical | `folder_id` + folders tree |
| *(future)* user labelsets | materialised | labels tables |

Endpoints:

- **`GET /api/dimensions`** — the registry: id, name, kind
  (flat / hierarchical / boolean). Drives the "+" menu; future user labelsets
  appear here with zero UI change.
- **`POST /api/items/query`** — body is the pill state:
  `{filters: [{dimension, values[]}], search: [...], sort, bounds?}`.
  Returns matching items of all three types in one unified shape.
  With `facet: <dimension>` it instead returns that dimension's value list
  **with counts, computed against the other active pills** — this populates
  dropdowns and gives "narrowed by previous pills" for free.
- Checking a hierarchy node at any level (state, region, LGA) matches
  everything beneath it; expanding lets you check deeper levels instead.
  This is how "find by start, end, or both at any location level" works.
- Search strings ride in the same body and AND with everything else.

## UI

Filter row at the top of the left panel: pills, then a **+** button; search
box keeps today's placement, its non-empty query rendering as a pill.

- **+** opens the dimension menu (from `/api/dimensions`). Picking one adds a
  pill and opens its dropdown: checkbox list with faceted counts;
  hierarchical dimensions render an expandable tree, checkable at any level.
- Boolean dimensions skip the dropdown — the pill itself toggles.
- A pill shows dimension + summary ("Start: Maroota +2"); click reopens the
  dropdown, × removes it. Zero-checked pills are inactive (match everything).
- The list shows exactly the pill-filtered set — tracks, routes, packs
  interleaved with type icons, sort preserved. Pill state is shared with the
  map store so the map dims non-matching tracks (as search does today).
- Click-to-toggle selection; selection affects display only, never list
  membership.

A mockup (real Plan palette, open Start-location dropdown with tree +
faceted counts) was validated during design review.

## Rollout

Each step ships independently:

1. **Migration:** folders table, `folder_id` columns, pack attribute columns
   + backfill, `collection` → folders, ride `has_hr`/`has_speed` caching if
   needed.
2. **Server:** dimension registry, `/api/dimensions`, `/api/items/query`
   with faceting. Existing endpoints untouched — old list keeps working.
3. **UI:** pill row replaces the current filter panel and the Layers ride
   entries in `ListPane`; search-as-pill; click-to-toggle selection; remove
   focus-mode list replacement.
4. **Cleanup:** retire old filter plumbing (`rideMatchesFilters` settings
   toggles that pills now cover).

## Testing

- Registry unit tests: each dimension's facet + filter SQL against a seeded
  DB — especially hierarchy rollups (checking an LGA matches all its
  suburbs).
- Pack recompute: membership change → attributes update; backfill
  idempotent.
- API: faceting respects the other active pills; unified item shape covers
  all three types.
- UI: selection toggling never changes list contents.

## Out of scope (designed for, not built)

User labelsets/tags, search-suggests-pills autocomplete, per-pill NOT /
exclude, heatmaps as list items.
