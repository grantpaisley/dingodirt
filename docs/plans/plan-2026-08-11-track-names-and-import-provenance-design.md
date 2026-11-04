# Track names, deletion, and import provenance

Date: 2026-08-11
Status: agreed in brainstorm, not yet implemented

## Problem

Three gaps, all rooted in the import path.

1. **Uploaded names are destroyed.** The namer overwrites `rides.name` and
   preserves the old value in `rides.original_name`, but only once. After a
   manual rename (`name_source = 'user'`) the generated name is gone for good
   and cannot be recovered. There is no way to switch a track back and forth
   between the name its file carried and the name Dingo built.
2. **Zip structure is thrown away.** `extract_tracks_into` takes the basename
   of each archive member and writes it into a numbered scratch directory.
   The archive name and the internal folder path are both lost, so a
   400-track zip lands as 400 unfiled rides.
3. **Provenance is unstructured.** `rides.source` is a free-text label and
   `files.source_path` holds a local filesystem path that, for web uploads,
   points at a scratch directory. Neither answers "which URL did this come
   from" or "which archive, and where inside it".

There is also no way to delete a track or route at all.

## Decisions

| Topic | Decision |
|---|---|
| Name storage | Four name columns side by side, plus a pointer. |
| Filename | Its own column and pointer value, copied at import. |
| Switching | Per-ride pointer, junk-aware default at import, bulk re-point action. |
| Deletion | Soft delete with a purge step. |
| Zip folders | Mirror the archive path, collapse redundant levels. |
| Provenance | An `imports` table, one row per import event. |

## Name model

### Columns

| Column | Pointer value | Source |
|---|---|---|
| `original_name` | `original` | GPX `<trk><name>` — exists today |
| `filename` | `filename` | copied from `files.original_name` at import |
| `generated_name` | `generated` | the namer |
| `custom_name` | `custom` | typed by the user |
| `name` | — | the resolved value, written by the app |
| `name_source` | — | the pointer |

`name` stays a real column rather than a Postgres generated column, so the
existing list, search, export and share queries need no change. The
application owns the invariant: whenever a variant or the pointer changes,
`name` is re-resolved in the same statement.

The enum value `user` is renamed to `custom` so the pointer and the column
read the same word:

```sql
ALTER TYPE ride_name_source RENAME VALUE 'user' TO 'custom';
```

Three sites in `core/rust/enrich/src/ride_naming.rs` read the old value
(lines 286, 299, and the `UPDATE` near 516), plus the Plan detail pane.

### Resolution and fallback

A chosen variant can be empty — most GPX files carry no `<trk><name>`. The
resolver walks:

**chosen variant → `original_name` → `filename` → `generated_name` →
`"Untitled"`**

This is a single SQL expression, defined once as a function so the daemon and
any backfill cannot drift:

```sql
CREATE OR REPLACE FUNCTION resolve_ride_name(
    p_source ride_name_source,
    p_original TEXT, p_filename TEXT, p_generated TEXT, p_custom TEXT
) RETURNS TEXT AS $$
    SELECT COALESCE(
        NULLIF(CASE p_source
            WHEN 'original'  THEN p_original
            WHEN 'filename'  THEN p_filename
            WHEN 'generated' THEN p_generated
            WHEN 'custom'    THEN p_custom
        END, ''),
        NULLIF(p_original, ''), NULLIF(p_filename, ''),
        NULLIF(p_generated, ''), 'Untitled')
$$ LANGUAGE sql IMMUTABLE;
```

### The namer stops clobbering

`name_one_ride` currently writes `original_name = COALESCE(original_name,
name)`, `name = $2`, `name_source = 'generated'`. It changes to write
`generated_name = $2` and then re-resolve `name`. It must **not** touch
`name_source` — the pointer is the user's choice, and the namer only refreshes
the variant it owns. This also means the namer can run over every ride,
including manually renamed ones, without destroying anything.

`assemble_name` **stops appending the original in brackets**. Today it
produces `Maroota loop via Canoelands 31 kms 2.8 hrs on 2026-06-01 (Wisemans
Loop)`. With the two names stored separately, the suffix is duplication.
Generated names become clean, and the `is_junk_name` guard around the suffix
is no longer needed there.

### Choosing the default at import

`is_junk_name` already detects worthless names — `Morning Ride`, `Ride`, and
similar. At import:

- original name present and not junk → `name_source = 'original'`
- otherwise → `name_source = 'generated'`

This gives the right answer for both real cases: a curated DSRA zip keeps its
names, and a Garmin export of your own recordings gets described names.

### Changing it later

A bulk action re-points a selection or a whole folder:

`PATCH /api/rides/name-source` with `{ ride_ids: [...], name_source: "..." }`,
re-resolving `name` for each row. The Plan detail pane gains a per-ride picker
listing the four variants with their current values, so you can see what you
are choosing before you choose it.

## Deletion

### Model

`rides.deleted_at TIMESTAMPTZ` — NULL means live. Every list, map, filter and
export query gains `AND deleted_at IS NULL`. A "Deleted" view lists them, with
Restore and Purge.

### Why a purge step is required

A hard delete alone is unsafe here, for four reasons found in the schema:

1. **Re-import cannot restore it.** `service.rs:68` skips any file whose
   SHA256 is already in `files`. Delete the ride, keep the `files` row, and
   re-importing that GPX does nothing at all.
2. **Published shares break.** `shares.ride_ids` is a `UUID[]` with no foreign
   key. A delete leaves a dangling id in a published plan page.
3. **Derived data cascades.** `runs`, `rematch_queue`, `ride_turn_marks`,
   `pois` and `pack_rides` all cascade from `rides`. `photos.ride_id` and
   `rides.superseded_by` go NULL. Removing a ride changes segment time ranges,
   so those need a recompute.
4. **The bytes leak.** The cascade runs `files` → `rides`, not the reverse.
   Deleting a ride leaves the `files` row and the content-addressed bytes on
   disk. And `pois.file_id` has no delete action, so removing the `files` row
   fails while POIs still point at it.

### Purge behaviour

Purging a ride, in one transaction:

- refuse, with a clear message, if the ride is in a **published** share, and
  offer to unpublish first;
- delete the ride row, letting the cascades run;
- delete the `files` row when no remaining ride references it, and remove the
  stored bytes — so a later re-import of the same GPX works again;
- re-point or delete POIs that reference the file;
- queue the affected segments for a stats recompute.

### Endpoints

```
DELETE /api/rides/{id}                soft delete
POST   /api/rides/delete              soft delete many  { ride_ids: [...] }
POST   /api/rides/{id}/restore        undo
DELETE /api/rides/{id}/purge          permanent
POST   /api/imports/{id}/delete       soft delete a whole import batch
```

The batch endpoint is what makes a bad zip survivable: one action, not 400.

## Zip import and folders

### Archive path is preserved

`extract_tracks` returns `Vec<ExtractedTrack>` rather than `Vec<PathBuf>`:

```rust
pub struct ExtractedTrack {
    pub path: PathBuf,          // the scratch file, as today
    pub archive_path: String,   // 'Flinders2026/Day 2/leg-3.gpx'
}
```

The traversal guard at `zip.rs:453` moves rather than disappears. Scratch
files keep the numbered-subdirectory layout — the archive path is metadata,
never joined onto a filesystem path. Folder names are built from sanitised
segments; `..`, empty segments and absolute prefixes are rejected.

### Folder mapping

The zip name is the root folder. Internal folders nest under it. Redundant
levels collapse:

```
Flinders2026.zip                        Flinders2026
└── Flinders2026/                       ├── Day 1
    ├── Day 1/                          │   ├── leg-1
    │   ├── leg-1.gpx        ──▶        │   └── leg-2
    │   └── leg-2.gpx                   ├── Day 2
    ├── Day 2/                          │   └── leg-3
    │   └── leg-3.gpx                   └── overview
    └── overview.gpx
```

Rules:

- a lone top-level folder whose name equals the zip name is dropped;
- `__MACOSX` and dot-folders are skipped;
- a **nested zip becomes a folder level**, named after the zip without `.zip`;
- a plain multi-file upload creates no folder — the tracks go to Unfiled;
- `rides.folder_id` is set to the deepest folder for each track.

Re-import is idempotent by construction: `folders` has `UNIQUE (parent_id,
name)` plus the root partial unique index, so folders are reused, and
`files.hash` is UNIQUE, so tracks are not duplicated. A changed zip adds its
new tracks to the same folders.

## Import provenance

### Schema

```sql
CREATE TYPE import_kind AS ENUM
    ('upload','url','archive','strava','gmaps','device','manual');

CREATE TABLE imports (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind        import_kind NOT NULL,
    ref         TEXT,        -- the URL, or 'Flinders2026.zip'
    label       TEXT,        -- attribution: 'dsra', 'wikiloc', a mate's name
    folder_id   UUID REFERENCES folders(id) ON DELETE SET NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    ride_count  INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE rides ADD COLUMN import_id UUID REFERENCES imports(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN archive_path TEXT;
```

`files.source_path` is left alone — it holds the canonicalised local path and
`imported_from_folder` (`rides.rs:171`) derives a display value from it.
`archive_path` is the new, separate concept: the path inside the archive.

`rides.source` stays as the human attribution label. `imports.label` seeds it
at import; the two stay independent afterwards so a per-ride correction is
possible.

### Why an event table

Source belongs to the import event, not to the bytes. The same GPX can arrive
twice from two different places, and `files.hash` is UNIQUE — so provenance
stored on `files` would record only the first arrival. An event row also
stores a URL once instead of on all 400 rides of a zip, and gives the batch
delete a target.

### Writers

Five paths must create an `imports` row. This is the main cost of the design:

| Path | Kind | `ref` |
|---|---|---|
| `daemon/src/routes/import.rs` — web upload | `upload` or `archive` | filename or zip name |
| `daemon/src/routes/import.rs` — `import_gmaps` | `gmaps` | the Google Maps URL |
| `ingest/src/routes_import.rs` | `archive` or `upload` | the source path |
| `cli/src/strava_sync.rs` | `strava` | the Strava activity URL |
| `dingo organize` | `upload` | the `Inbox/<source>/` folder |

## Migration

One file, `server/migrations/20260811000001_track_names_delete_and_imports.sql`.

Backfill for existing rides:

- `filename` ← `files.original_name` through `file_id`;
- `generated_name` ← `name` where `name_source = 'generated'`;
- `custom_name` ← `name` where `name_source = 'user'` (before the rename);
- `original_name` is already correct;
- strip the trailing ` (original)` suffix from backfilled `generated_name`
  values, since the old `assemble_name` embedded it;
- `name` re-resolved through `resolve_ride_name` for every row, which should
  be a no-op — worth asserting in a test.

## Risks

- **The bracket strip is lossy if it is wrong.** A generated name whose real
  suburb text ends in brackets could be mangled. Match only a suffix that
  equals the row's `original_name` in brackets, not any trailing bracket.
- **`AND deleted_at IS NULL` is easy to forget.** Every ride-reading query
  needs it. Consider a `live_rides` view and switch reads to it, so a missed
  call site is a compile error rather than a silent leak of deleted tracks.
- **Purge and published shares.** Until `shares.ride_ids` gains a foreign key
  or a check, the purge guard is the only protection.
- **Five import writers** can drift. A single helper that opens and closes an
  import should be the only way to create the row.

## Test plan

- `resolve_ride_name` fallback order, including every variant NULL.
- The namer refreshes `generated_name` without changing `name_source`, for all
  four pointer values.
- Junk-aware default: a `Morning Ride` GPX imports as `generated`; a
  `Wisemans Loop` GPX imports as `original`.
- Zip folder mapping over four fixtures: doubled top folder, nested folders,
  nested zip, `__MACOSX` present.
- Re-import of the same zip creates no duplicate folders and no duplicate
  rides.
- Purge removes the `files` row, and a re-import of the same GPX then
  succeeds — the regression that motivates the purge step.
- Purge is refused for a ride in a published share.

## Implementation order

1. Migration and `resolve_ride_name`.
2. Namer changes and the bracket removal, with backfill assertions.
3. Name picker and bulk re-point, in the daemon and the Plan detail pane.
4. Soft delete, restore, and the Deleted view.
5. Purge, with the file-orphan sweep and the share guard.
6. `extract_tracks` archive paths and the folder mapping.
7. The `imports` table and its five writers.
8. Batch delete of an import.

Steps 1–3 are independent of 4–5, and both are independent of 6–8. Three
branches, landed in that order.
