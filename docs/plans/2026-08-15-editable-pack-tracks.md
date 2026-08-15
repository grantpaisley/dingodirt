# Editable pack track lists (2026-08-15)

Grant: "We can't add or remove tracks from existing packs." Brainstorm option
chosen: **1 — editable pack manifest, rebuild only what changed.**

## What was actually broken

The data model and API were already right: a pack IS an ordered ride list
(`pack_rides`), and `PATCH /api/packs/{id}` replaces `ride_ids` wholesale.
The failure was in reachability, not capability:

1. **Remove** existed as an × per track row — at `opacity: 0`, shown only on
   row hover. On a touch screen there is no hover, so the button effectively
   did not exist.
2. **Add** existed only as "Add basket (N)", which renders only when the
   basket already holds tracks. With an empty basket the pack view offered
   no way in — the affordance was invisible exactly when you wanted it.
3. **Refresh cost**: republishing after an edit re-fetched every ESRI
   satellite tile of the corridor. Publish time is dominated by that fetch,
   so an edit to a big pack felt like rebuilding the world.

## The fix

- The × is always visible (dimmed, full strength on hover) — reachable on
  touch.
- A new **Add tracks** button in the pack detail opens an inline name-search
  over the whole library (`GET /api/rides?q=`); tapping a result appends it.
  The basket path stays for bulk adds.
- **ESRI tile disk cache** (`tilecache/esri/{z}/{x}/{y}` under the daemon's
  data dir, CWD-relative): fetches read through it and write back. A
  republish after an edit only fetches tiles the corridor gained; removing a
  track fetches nothing. World Imagery is effectively static — delete the
  directory to force a refresh. Strava layers already bake from the local
  harvest store, and basemap/hillshade extract from local PMTiles, so the
  satellite fetch was the only repeated network cost.

## Not done (deliberately)

- No delta endpoints (`add/remove/move`) — the wholesale `ride_ids` PATCH is
  simpler and already correct.
- No partial rebuild of the bundle zip itself: assembling the zip from local
  data takes seconds; only the network fetch was worth caching.
