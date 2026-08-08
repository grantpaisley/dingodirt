# List filtering with pills, folders, and labelsets

**Date:** 2026-08-07
**App:** Plan (left panel `ListPane`), server
**Status:** Implemented 2026-08-09 (v1: pills, folders, faceted API; user labelsets stay future work)

## Summary

Replace the ad-hoc filters in the Plan left panel with one faceted-filter
model. The old filters are the mode/class toggles, the Layers ride entries,
and focus mode. The new model is a row of **pills**. Each pill is one filter
dimension: Type, Owner, Start location, End location, Touches location,
Folder, Has HR, Has Speed, Is loop, or free-text search. Pills combine with
AND. Values in one pill combine with OR. The other active pills narrow each
dropdown value list and add counts (faceting). Also add a user-managed
**folder tree**. Each item has one home folder. Derive pack attributes from
the member rides, so packs filter together with tracks and routes.

## Decisions (with alternatives considered)

1. **Hybrid labelsets.** System dimensions are *virtual*. They are filter
   definitions over columns that `rides` already has (`suburbs[1]` = start
   suburb, `end_*`, `owner_id`, HR/speed presence…). User-created groupings
   are *materialised*: folders now, labels tables later. One "dimension" API
   shape exposes both, so the UI cannot tell the difference.
   *Rejected:* all-virtual, because it permits no future user labelsets.
   *Rejected:* all-materialised, because it duplicates the column data and
   needs a re-sync after a re-geocode.
2. **Packs derive attributes from member rides.** The pack row caches the
   attributes. A membership change causes a recompute. *Rejected:* geocode
   the pack geometry independently, because the results drift. *Rejected:*
   let packs opt out of the system dimensions, because the UI becomes
   inconsistent.
3. **Folders: single-home tree.** The table is `folders(id, name,
   parent_id)`. Rides and packs get a nullable `folder_id`.
   Multi-membership is what labels are for (future). Folders are
   type-agnostic. "GOAT NSW North" becomes an ordinary folder. That folder
   holds routes now, but it can hold tracks. *Rejected:* folders-as-labels
   with a "default" folder. That design bolts a uniqueness constraint onto a
   many-to-many table. Every move and every count then special-cases the
   default folder.
4. **Faceted-search semantics.** Pills combine with AND. The checked values
   in one pill combine with OR. A pill's dropdown shows only the values that
   match the *other* active pills, with counts. *Rejected:* a strict
   cascade, because it gives the same results with more bookkeeping.
   *Rejected:* a full boolean builder (YAGNI). A per-pill NOT can come
   later.
5. **v1 user labelling = folders only.** The labels/label_sets tables are
   designed (below) but not built. *Rejected for v1:* a flat Tags set, and
   full custom labelsets.
6. **Search is a pill.** A non-empty query becomes a pill. The pill combines
   with the rest with AND. Multiple search pills are permitted. The search
   matches the name, the **original name (as loaded)**, the description, the
   suburbs/LGAs/region, and the folder name.
7. **Layers ride entries dissolve into pills.** "My rides / Other rides /
   Fabio…" becomes an **Owner** dimension pill. Heatmap stays in Layers
   as-is for now. Heatmaps are not list items.
8. **Selection never mutates the list.** A click on an item toggles the
   selection. The first click selects. The second click deselects. This
   gives easy multi-select with no modifier keys. Selection drives only the
   highlight, the detail pane, and the map emphasis. The list changes only
   when the pills change. Focus mode's list replacement goes away.

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

- A NULL `folder_id` = root ("Unfiled"). When you delete a folder, the
  delete cascades to the child folders. The items fall back to Unfiled
  (`SET NULL`). The delete never removes the items.
- **`collection` migration:** a one-off migration creates a folder for each
  distinct `collection` value and files those rides. The `collection`
  column stays as import provenance (it survives re-downloads). The UI
  stops reading the column. Imports drop new planned routes into the folder
  with the matching name.

**Pack cached attributes** (mirroring rides):

```sql
ALTER TABLE packs ADD COLUMN
    state TEXT, region TEXT, lgas TEXT[], suburbs TEXT[],
    end_state TEXT, end_region TEXT, end_lga TEXT, end_suburb TEXT,
    has_hr BOOLEAN, has_speed BOOLEAN;
```

`recompute_pack_attributes(pack_id)` computes these values: the union of
the member `suburbs[]`/`lgas[]`, in order of first encounter across the
members; the start singles from the first member; the `end_*` values from
the last member; the booleans combined with OR. Every membership-changing
path calls it: add a ride, remove a ride, or create a pack revision. The
call is synchronous, because it is cheap. A one-off backfill covers the
existing packs.

**Rides:** nothing new, with one exception. Cache the `has_hr`/`has_speed`
booleans at ingest if presence now needs a segments join. Check
`ride_stats_columns` at implementation time.

**Future (designed, not built):**

```sql
label_sets(id, name)
labels(id, label_set_id, name, parent_id)      -- hierarchies via parent, like folders
item_labels(item_type, item_id, label_id)      -- item_type: ride | pack
```

## Dimension registry and API

A server-side registry holds one list of the filter dimensions. Each
dimension declares how it resolves. The UI never knows virtual from
materialised.

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

- **`GET /api/dimensions`** — returns the registry: id, name, kind
  (flat / hierarchical / boolean). This drives the "+" menu. Future user
  labelsets appear here with zero UI change.
- **`POST /api/items/query`** — the body is the pill state:
  `{filters: [{dimension, values[]}], search: [...], sort, bounds?}`.
  The endpoint returns the matching items of all three types in one unified
  shape. With `facet: <dimension>`, it instead returns that dimension's
  value list **with counts, computed against the other active pills**. This
  populates the dropdowns and gives "narrowed by previous pills" for free.
- A check on a hierarchy node at any level (state, region, LGA) matches
  everything below that node. An expanded node lets you check deeper levels
  instead. This is how "find by start, end, or both at any location level"
  works.
- Search strings travel in the same body and combine with everything else
  with AND.

## UI

The filter row sits at the top of the left panel: the pills, then a **+**
button. The search box keeps today's placement. Its non-empty query renders
as a pill.

- The **+** button opens the dimension menu (from `/api/dimensions`). When
  you pick a dimension, the UI adds a pill and opens its dropdown. The
  dropdown is a checkbox list with faceted counts. Hierarchical dimensions
  render an expandable tree. You can check the tree at any level.
- Boolean dimensions skip the dropdown. The pill itself toggles.
- A pill shows the dimension and a summary ("Start: Maroota +2"). A click
  reopens the dropdown. The × removes the pill. A pill with zero checked
  values is inactive and matches everything.
- The list shows exactly the pill-filtered set. Tracks, routes, and packs
  interleave with type icons. The sort stays the same. The map store shares
  the pill state, so the map dims the non-matching tracks (as search does
  today).
- A click toggles the selection. Selection affects the display only, never
  the list membership.

The design review validated a mockup. The mockup used the real Plan palette
and showed an open Start-location dropdown with the tree and the faceted
counts.

## Rollout

Each step ships independently:

1. **Migration:** the folders table, the `folder_id` columns, the pack
   attribute columns with backfill, the `collection` → folders migration,
   and the ride `has_hr`/`has_speed` caching if needed.
2. **Server:** the dimension registry, `/api/dimensions`, and
   `/api/items/query` with faceting. The existing endpoints stay untouched.
   The old list continues to work.
3. **UI:** the pill row replaces the current filter panel and the Layers
   ride entries in `ListPane`. Add search-as-pill and click-to-toggle
   selection. Remove the focus-mode list replacement.
4. **Cleanup:** retire the old filter plumbing (the `rideMatchesFilters`
   settings toggles that pills now cover).

## Testing

- Registry unit tests: test each dimension's facet SQL and filter SQL
  against a seeded DB. Give special attention to the hierarchy rollups (a
  check on an LGA matches all its suburbs).
- Pack recompute: a membership change updates the attributes. The backfill
  is idempotent.
- API: the faceting obeys the other active pills. The unified item shape
  covers all three types.
- UI: selection toggling never changes the list contents.

## Out of scope (designed for, not built)

User labelsets/tags, search-suggests-pills autocomplete, per-pill NOT /
exclude, and heatmaps as list items.
