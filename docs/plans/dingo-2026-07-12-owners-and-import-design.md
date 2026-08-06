# Owners & Import — provenance for every track, me-vs-everyone rendering

**Date:** 2026-07-12
**Status:** Design (approved via brainstorm; not yet implemented)
**Refines:** `2026-07-12-heat-harvester-design.md` — the harvester's
`heat_sources` table (kind `mine`/`others`/`strava`) folds into the `owners`
table defined here. Owners *are* the source concept.

## Problem / goal

Dingo treats every ride as implicitly the user's own. We want to:

- Import GPX/FIT from **friends** and from **arbitrary third-party sources**
  (Trailforks, club exports, OSM traces), tagging each batch with an **owner**.
- Keep the user's own view pristine by default, but let owners' tracks be
  browsed, filtered, and rendered as heat on demand.
- Render as **me vs everyone else**: the focus owner highlighted, everyone else
  (including Strava) as uniform blue heat.
- Do this via a top-right **Import** button, reusing the existing ingest routine.

Owner subsumes "source": one provenance concept, `mine`/`others`/`strava`
derived from it.

## Data model

New **`owners`** table; every ride gains an owner.

- **`owners`**
  - `id`
  - `kind` — `me` | `friend` | `source` | `synthetic`
  - `email` — unique; **required for `me`/`friend`**, null for `source`/`synthetic`
  - `name` / `nickname` — display label; **the identity key for `source`**
    (unique among sources), display name for people
  - `created_at`
  - (No per-owner `colour` — see rendering; it would be unused.)
- **`rides.owner_id`** — FK to `owners`, `NOT NULL`.

**Identity key by kind:** `me`/`friend` → email (re-adding an email reuses the
owner; new rides append to it). `source` → unique name ("Trailforks AU"). This
keeps the email-key story for people while supporting nameless third-party data.

**Seeding & backfill (one migration):**
- Insert a **`me`** owner (`kind=me`, email `grant@angrykoala.com.au`, editable
  nickname); backfill all existing rides to it. Behaviour is unchanged — the data
  just all belongs to "me" now.
- Insert a synthetic **`Strava global`** owner (`kind=synthetic`) so harvested
  Strava heat hangs off the same concept. This replaces the harvester design's
  separate `heat_sources` table.

**Kinds** carry the three provenance flavours without a separate `source` column;
the UI's "mine / others / strava" is derived from `kind`.

## Import flow & UI

**Top-right "Import" button** → dialog with three parts:

1. **File source** (both mechanisms):
   - Drag-drop / file-picker (multi-file + folder mode via `webkitdirectory`), or
   - a **server-path** field the daemon reads directly (for large local
     archives — no upload).
2. **Owner assignment** (one owner per import batch):
   - Dropdown of existing owners, or
   - "Add new…" → toggle **Person** (email + nickname) or **Source** (name).
3. **Import** → progress readout (parsed / rides vs routes / added /
   skipped-duplicate).

Behind the button: a new daemon `/api/import` endpoint reusing the existing
`dingo ingest` routine; the server-path mode is the same routine pointed at a
directory.

**Auto route/ride classification on ingest:** if a track has **no per-point
timestamps → `track_type = plan` (route)**; if it has timestamps → `ride`. Route
planners (Komoot, Trailforks) export timeless GPX; recordings carry time. Applies
to every owner. Reuses Dingo's existing plan/ride distinction.

Each imported track is stamped with the batch's `owner_id`.

## Filtering & rendering: me vs everyone else

**Two colour buckets, not per-owner hues:**
- **Focus owner** — rendered in the distinct highlight colour (orange), with full
  per-track analysis (mode / HR / speed / grade). Drives the "N rides" stat and
  track list.
- **Everyone else** — uniform **blue** heat, including Strava, whether it's all
  others combined or filtered to a single person. Filtering to one owner does not
  change their colour; it's still blue.

Colour is two app constants (focus = orange, others = blue), not stored per owner.

**Focus-owner selector (dropdown, default = the `me` owner):**
- Future-proof: in a multi-user app, focus = the logged-in user, no rework.
- Useful now: pivot perspective — focus a friend to study *their* routes in
  orange/full-detail while your own drop into the ambient blue pool.

**Owner filter (checkbox list, mirrors the existing "Track types" toggle):**
- Picks which non-focus owners are in the blue heat pool; Strava is one entry.
- **Also filters the track list / basket / stats** — browse or select any
  owner's tracks (e.g. just "Trailforks AU"). This list filter is independent of
  the map's focus/blue split, so you can list a friend's rides while the map still
  focuses you.
- Default state: focus = me, others off — exactly today's view. Importing a
  friend's 500 rides or a 10k-track dump never disturbs the default view.

**Ties to harvester:** the blue "everyone else" pool *is* the aggregate heat
layer; toggling Strava on is ticking one owner. One legend, one owner list drives
both the list filter and the heat toggles.

## Edge cases

- **Dedup on re-import:** ingest is content-addressed, so re-importing the same
  file is skipped. Refinement: dedup **within an owner** — identical GPS content
  under a *different* owner is kept (two people legitimately rode the same trail),
  not merged.
- **Enrichment:** the user's rides get the full pipeline (weather, naming, mode)
  as today. Bulk `friend`/`source` imports **skip heavy enrichment by default**
  (no weather on 10k routes) but still get the cheap mode/route classification.
- **Owner management:** a small view to edit nickname/email and delete an owner.
  Delete prompts: remove their rides, or reassign.

## YAGNI — not now

Owner merging; avatars / contact sync; any auth or sharing (the future multi-user
story the focus dropdown anticipates); per-owner heat colours (dropped — it is
me-orange vs others-blue).

## Relationship to the harvester design

- The harvester's `heat_sources` table is **replaced** by `owners` (Strava = a
  `synthetic` owner). Its GPX→tiles baker becomes the "rasterise a `source`
  owner" path; its Strava sweep produces the `Strava global` owner's tiles.
- Rendering: harvested tiles and baked friend/source tiles all land in the blue
  "everyone else" pool; the user's own rides remain the orange vector focus.
