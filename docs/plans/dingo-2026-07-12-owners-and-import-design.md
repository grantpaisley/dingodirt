# Owners & Import — provenance for every track, me-vs-everyone rendering

**Date:** 2026-07-12
**Status:** Design (approved via brainstorm; not yet implemented)
**Refines:** `2026-07-12-heat-harvester-design.md` — the `heat_sources` table
of the harvester (kind `mine`/`others`/`strava`) folds into the `owners`
table that this document defines. Owners *are* the source concept.

## Problem / goal

Dingo treats every ride as the user's own by default. We want to:

- Import GPX/FIT from **friends** and from **arbitrary third-party sources**
  (Trailforks, club exports, OSM traces). Tag each batch with an **owner**.
- Keep the user's own view clean by default. But let the user browse, filter,
  and render the tracks of owners as heat on demand.
- Render as **me vs everyone else**: highlight the focus owner. Show everyone
  else (including Strava) as uniform blue heat.
- Do this with a top-right **Import** button. Reuse the existing ingest
  routine.

Owner subsumes "source": one provenance concept. `mine`/`others`/`strava`
derive from it.

## Data model

A new **`owners`** table; every ride gains an owner.

- **`owners`**
  - `id`
  - `kind` — `me` | `friend` | `source` | `synthetic`
  - `email` — unique; **required for `me`/`friend`**, null for
    `source`/`synthetic`
  - `name` / `nickname` — the display label; **the identity key for `source`**
    (unique among sources), and the display name for people
  - `created_at`
  - (No `colour` per owner — see rendering; it would be unused.)
- **`rides.owner_id`** — an FK to `owners`, `NOT NULL`.

**Identity key by kind:** `me`/`friend` → the email. When you add an email
again, the import reuses that owner, and new rides append to it. `source` → a
unique name ("Trailforks AU"). This keeps the email-key story for people and
also supports nameless third-party data.

**Seeding & backfill (one migration):**
- Insert a **`me`** owner (`kind=me`, email `grant@angrykoala.com.au`,
  editable nickname). Backfill all existing rides to it. The behaviour does
  not change — the data just all belongs to "me" now.
- Insert a synthetic **`Strava global`** owner (`kind=synthetic`), so
  harvested Strava heat hangs off the same concept. This replaces the
  separate `heat_sources` table from the harvester design.

**Kinds** carry the three provenance flavours without a separate `source`
column. The UI derives "mine / others / strava" from `kind`.

## Import flow & UI

The **top-right "Import" button** opens a dialog with three parts:

1. **File source** (both mechanisms):
   - Drag-drop or a file-picker (multi-file + folder mode via
     `webkitdirectory`), or
   - a **server-path** field that the daemon reads directly (for large local
     archives — no upload).
2. **Owner assignment** (one owner per import batch):
   - A dropdown of the existing owners, or
   - "Add new…" → toggle **Person** (email + nickname) or **Source** (name).
3. **Import** → a progress readout (parsed / rides vs routes / added /
   skipped-duplicate).

Behind the button: a new daemon `/api/import` endpoint that reuses the
existing `dingo ingest` routine. The server-path mode is the same routine,
pointed at a directory.

**Auto route/ride classification on ingest:** if a track has **no per-point
timestamps → `track_type = plan` (route)**. If it has timestamps → `ride`.
Route planners (Komoot, Trailforks) export timeless GPX; recordings carry
time. This rule applies to every owner. It reuses the existing plan/ride
distinction of Dingo.

The import stamps each track with the `owner_id` of the batch.

## Filtering & rendering: me vs everyone else

**Two colour buckets, not hues per owner:**
- **Focus owner** — rendered in the distinct highlight colour (orange), with
  the full per-track analysis (mode / HR / speed / grade). This owner drives
  the "N rides" stat and the track list.
- **Everyone else** — uniform **blue** heat, Strava included. This holds
  whether the pool is all others combined or filtered to one person. A filter
  to one owner does not change their colour; it is still blue.

Colour is two app constants (focus = orange, others = blue), not a value
stored per owner.

**Focus-owner selector (a dropdown, default = the `me` owner):**
- Future-proof: in a multi-user app, the focus is the logged-in user — no
  rework.
- Useful now: pivot the perspective. Focus a friend to study *their* routes
  in orange with full detail, while your own rides drop into the ambient
  blue pool.

**Owner filter (a checkbox list that mirrors the existing "Track types"
toggle):**
- It picks which non-focus owners are in the blue heat pool. Strava is one
  entry.
- **It also filters the track list, the basket, and the stats.** You can
  browse or select the tracks of any owner (for example, just "Trailforks
  AU"). This list filter is independent of the focus/blue split of the map.
  You can thus list the rides of a friend while the map still focuses on you.
- Default state: focus = me, others off — exactly today's view. An import of
  a friend's 500 rides, or a 10k-track dump, never disturbs the default view.

**Ties to the harvester:** the blue "everyone else" pool *is* the aggregate
heat layer. To toggle Strava on is to tick one owner. One legend and one
owner list drive both the list filter and the heat toggles.

## Edge cases

- **Dedup on re-import:** ingest is content-addressed, so it skips a
  re-import of the same file. Refinement: dedup **within an owner**. The
  system keeps identical GPS content under a *different* owner and does not
  merge it (two people legitimately rode the same trail).
- **Enrichment:** the rides of the user get the full pipeline (weather,
  naming, mode) as today. Bulk `friend`/`source` imports **skip heavy
  enrichment by default** (no weather on 10k routes). They still get the
  cheap mode/route classification.
- **Owner management:** a small view to edit the nickname or the email, and
  to delete an owner. On delete, a prompt asks: remove their rides, or
  reassign them.

## YAGNI — not now

Owner merges; avatars and contact sync; any auth or sharing (the future
multi-user story that the focus dropdown anticipates); heat colours per owner
(dropped — it is me-orange vs others-blue).

## Relationship to the harvester design

- The `owners` table **replaces** the `heat_sources` table of the harvester
  (Strava = a `synthetic` owner). The GPX→tiles baker of the harvester
  becomes the "rasterise a `source` owner" path. The Strava sweep of the
  harvester produces the tiles of the `Strava global` owner.
- Rendering: harvested tiles and baked friend/source tiles all land in the
  blue "everyone else" pool. The user's own rides stay the orange vector
  focus.
