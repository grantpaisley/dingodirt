# Trip film — auto-assembled ride videos from GPX, photos, and clips

*2026-09-06. Brainstorm with the owner. Status: design agreed in conversation, nothing built. Companion code once it exists: `apps/film/`, `core/rust/media/`.*

## Goal

Turn one adventure-bike trip (a GPX track, geotagged photos, HoverAir drone clips, phone clips) into a 5 to 15 minute 16:9 film for YouTube, Facebook, or friends, with a Relive-style map fly-through between moments, the owner's own voice-over, and the owner's own music.

The tool proposes and assembles. The owner curates. It is not an unattended auto-editor: the workflow includes choosing which source footage goes in.

## Decisions taken

| Question | Decision |
|---|---|
| First output | 16:9 YouTube film, 5 to 15 min. Vertical reels later. |
| Cameras | HoverAir X1 Pro Max (no GPS, timestamp only) and phone. Placed on the route by clock time. |
| Curation | Card picker: the app proposes one best moment per clip, the owner keeps, rejects, or retrims. Full timeline editor is out of scope. |
| Music | Owner supplies an MP3 or WAV per film. No bundled library, no generated music. |
| Voice-over | Recorded in the browser while watching the rough cut, so every sentence is timestamped against the cut. |
| Runs where | Locally on the owner's Mac against the existing daemon. Not on the website. |
| Lives where | A fifth app, `apps/film`, no-build ES modules like Nav and Studio. A new Rust crate, `core/rust/media`. |

## One artefact: the edit decision list

A film is a JSON edit decision list (EDL). Every stage either produces an EDL or transforms one:

- **Rough cut** generates an EDL from kept moments.
- **Curation** edits it.
- **Recut** rewrites it to fit the narration and the beat grid.
- **Render** turns it into an MP4.

Each stage is a pure function over the EDL, testable without a browser or ffmpeg.

```jsonc
{
  "schemaVersion": 1,
  "fps": 30, "width": 1920, "height": 1080,
  "rideIds": ["…"],
  "music": { "path": "…", "beats": [0.52, 1.03, …], "downbeats": [0.52, 2.58, …] },
  "narration": { "path": "…", "sentences": [ { "t0": 3.1, "t1": 6.4, "text": "…", "anchor": "seg-7", "confidence": 0.9 } ] },
  "segments": [
    { "id": "seg-1", "kind": "map",   "move": "follow", "fromD": 0,     "toD": 4200,  "dur": 6.0 },
    { "id": "seg-2", "kind": "clip",  "videoId": "…", "in": 12.4, "out": 18.4, "dur": 6.0, "audio": 0.3 },
    { "id": "seg-3", "kind": "map",   "move": "hop",    "fromD": 4200,  "toD": 61000, "dur": 5.0 },
    { "id": "seg-4", "kind": "photo", "photoId": "…", "dur": 3.5, "kenBurns": "in" },
    { "id": "seg-5", "kind": "title", "text": "Day 2 — Cooktown", "dur": 2.5 }
  ],
  "transitions": { "default": "xfade", "durS": 0.4 }
}
```

`fromD`/`toD` are metres along the ride, the same distance cursor `Replay.d` uses in `apps/studio/js/replay.js`. Map segments are elastic: their `dur` is what the recut stretches or shrinks to absorb slack.

## Stage 1 — ingest and align

**Videos table.** `server/migrations/…_create_videos_table.sql` mirrors `photos`: `id, sha256, source ('hover'|'phone'|…), original_path, duration_ms, recorded_at, location (interpolated), ride_id, match_method, strip_path, scores_path, width, height, created_at`. Full-resolution files stay where they are; the daemon stores only the thumbnail strip and the per-second score JSON.

**Probe.** The `media` crate shells out to `ffprobe` for duration, creation time, dimensions, and to `ffmpeg` for a thumbnail strip (one frame per second at 160 px). HoverAir clips carry a creation time in the MP4 `creation_time` tag and in the filename. Which one is trustworthy is a spike item.

**Place on the route.** `recorded_at + camera clock offset` is looked up against the ride's timestamps, exactly as `core/rust/google/src/photo_match.rs` does for photos with `match_method = 'timestamp'`. Reuse that code path rather than writing a second interpolator.

**Clock offset per camera.** A `camera_clock_offsets (source, offset_s, set_from_video_id)` table. In the app the owner drags one clip's pin to where it was shot, or picks the ride timestamp from the elevation strip. The offset then applies to every clip from that camera. The drone stores local time with no timezone, so this step is mandatory, not a nicety.

**Screen.** A map with the ride, the photos already matched, and each clip as a pin with its first frame. Unplaced clips sit in a tray with a "pin this clip" affordance.

## Stage 2 — propose and curate

**Score every second of every clip.** The `media` crate blends cheap signals into one score curve per clip:

- **Ride motion.** Speed and turn density at that instant from the GPX, via `core/rust/geo/src/turns.rs` and `stops.rs`.
- **Frame motion.** Mean absolute difference between consecutive strip frames.
- **Audio energy.** RMS loudness of the clip's own track, from ffmpeg `astats`.
- **Exposure sanity.** Mean luma outside a sane band scores zero.
- **You stopped here.** Distance to the nearest photo cluster. A cluster means it was worth looking at.

The proposal is the highest-scoring window of the target length (4 to 8 s, configurable), excluding the first and last second of the clip where a hand is usually in shot. Scores are computed once at ingest and cached in `scores_path`.

**Card picker.** Cards ordered by distance along the route. Each card shows the strip with the score curve under it, the proposed window highlighted, and keep / reject / retrim. Retrim slides the window; the score curve explains why the proposal landed where it did. Keeping writes the segment into the EDL. Photos get cards too, defaulting to keep.

**Rough cut.** Kept moments in route order, a map segment filled into every gap, a title card at each day boundary. This is the first watchable film and exists before narration or music.

## Stage 3 — the map fly-through

**Two moves, chosen per gap.** A gap shorter than a threshold (start at 15 km, expose it as a setting) is a **follow**: the camera rides the track using Studio's replay engine and its speed-to-zoom follow camera, at a playback rate chosen so the segment lands near its `dur`. A longer gap is a **hop**: pull back until both endpoints and the trace so far are in frame, hold for a beat, then dive to the next location. The owner can override the move per segment on its card.

The trace draws itself as the cursor advances. Pins drop where kept moments live. The film reads as a growing map of the trip.

**Deterministic frames.** Today `Replay` ticks on a wall-clock `setInterval` and `NavView._followCamera` (`apps/studio/js/navview.js`) calls `map.easeTo` with an ease duration. Neither can answer "where is the camera at frame 1,234". Promote both into a shared module, `core/js/camera-driver.js` or similar, with one function:

```js
poseAt(edlSegment, tSeconds, viewport) → { center, zoom, bearing, pitch, cursorD }
```

It reads the same `camera.*` tokens from `apps/studio/js/behavior.js` (`zoomCurve`, `lookAhead`, `pitch`, `maxZoom`), so a `.dingobehavior` profile also styles the film. Live preview in the browser calls it on `requestAnimationFrame`. The renderer calls it once per frame and uses `map.jumpTo`. Preview and render therefore cannot drift apart. Studio keeps working: its live replay becomes a thin wall-clock wrapper around the same function.

**Renderer.** Playwright drives headless Chromium at the film's resolution, loads the same map page the app uses, and for each frame: `jumpTo(poseAt(...))`, await `map.once('idle')` with a timeout, `page.screenshot`, write to ffmpeg's stdin as `image2pipe`. Tiles come from the local PMTiles archives so idle waits are short. Each map segment renders to its own intermediate MP4. Only map segments go through the browser; clips and photos never do.

## Stage 4 — narrate, recut, beat-snap

**Capture.** The rough cut plays in the browser. `MediaRecorder` captures the mic. The take is stored with its start offset against EDL time zero. Multiple takes are allowed; the latest take covering a region wins.

**Transcribe.** whisper.cpp locally, sentence-level timestamps. Seed the prompt with place names from the enrich crate's gazetteer for the ride's area so Australian place names come out right.

**Anchor each sentence to a segment.** Default anchor: whatever segment was on screen when the sentence started. Because the owner narrated over the rough cut, this is right most of the time. An LLM pass then reads the transcript with the list of candidate segments (place name from the gazetteer, day number, photo count, clip kind) and moves the anchor when a sentence plainly names a different moment ("that river crossing on day two…"). Each anchor carries a confidence; below a threshold the default stands.

**Recut rules, in order of precedence.**

1. A segment must stay on screen for the whole of every sentence anchored to it, plus 0.5 s padding.
2. Never cut mid-sentence.
3. Segments with no narration keep their proposed duration.
4. Map segments are elastic and absorb slack in both directions, by changing the follow rate or the hop hold.
5. Reorder only on a high-confidence LLM anchor that contradicts route order; otherwise route order holds.
6. After durations are settled, snap each cut to the nearest beat within ±250 ms. Hop landings prefer downbeats. A beat that would violate rule 1 or 2 is skipped for the next one.

**Beat grid.** Computed once per music file at upload: onsets, tempo, downbeats. First choice is `aubio` (CLI or bindings); fall back to an onset detector on the ffmpeg-decoded PCM if the dependency is awkward. Stored on the EDL under `music.beats`.

**Audio mix.** Music ducked under voice with ffmpeg `sidechaincompress`. Clip ambient audio at a low level under its own clip, muted under map segments. Photos and titles carry music only.

## Stage 5 — render

One ffmpeg invocation per film, built by the `media` crate from the EDL:

- Map segments: the intermediate MP4s from Stage 3.
- Clips: `-ss`/`-t` trims, scaled and padded to 1920×1080, `setpts` for any speed change.
- Photos: `zoompan` for the slow push-in.
- Titles: rendered by the browser as PNGs with alpha, overlaid.
- Joins: `xfade` with the EDL's default transition, `acrossfade` on audio.
- Output: H.264 High, 1080p30, AAC 192 kbps, moov atom at front for YouTube.

Rendering is a daemon job with progress (`/api/jobs/{id}`), since a 10 minute film takes minutes.

## API surface

- `POST /api/videos/scan { dir }` — probe and register every clip in a folder.
- `GET /api/videos?ride=` — clips placed on that ride.
- `POST /api/videos/{id}/pin { rideTimestamp }` — sets the camera clock offset from one clip.
- `GET /api/videos/{id}/scores` — the per-second curve.
- `POST /api/films`, `GET|PUT /api/films/{id}` — the EDL.
- `POST /api/films/{id}/rough-cut` — generate segments from kept moments.
- `POST /api/films/{id}/music`, `POST /api/films/{id}/narration` — uploads; the daemon computes beats and the transcript.
- `POST /api/films/{id}/recut` — apply the recut rules.
- `POST /api/films/{id}/render` → job id.

A `films` table: `id, name, ride_ids, edl JSONB, music_path, narration_path, rendered_path, status, created_at, updated_at`.

## Build order

Every step ends in a watchable MP4, so the owner can judge the result rather than the plumbing.

| Step | Delivers | Rough size |
|---|---|---|
| 0. Spike | Headless MapLibre → ffmpeg at 1080p30 with a measured frames-per-second figure. whisper.cpp on a 2 minute Australian narration. HoverAir `creation_time` trustworthiness. | 3 days |
| 1. Ingest and align | `videos` table, probe, strips, timestamp placement, clock pin. | 1 week |
| 2. Rough cut, map and photos only | EDL generator, camera driver module, renderer, film of the route with photos. | 1.5 weeks |
| 3. Card picker | Scoring, cards, clips in the EDL. | 1.5 weeks |
| 4. Narration, duration-fit recut | Capture, transcript, rules 1 to 4, no beats, no LLM. | 1 week |
| 5. Beats and ducking | Beat grid, rule 6, audio mix. | 3 days |
| 6. LLM anchoring | Rule 5, reorder on confident anchors. | 1 week |

About eight focused weeks solo. Step 0 is cheap insurance against the two unknowns that could change the design: headless WebGL throughput, and whether narration-driven recut feels right at all.

## Risks

- **Clock offsets.** Wrong by an hour from a timezone slip puts clips on the wrong day. Show the offset in plain text and the placed pin on the map before anything else uses it.
- **Headless WebGL.** Chromium headless on macOS has GPU access; on Linux it may fall back to SwiftShader and render slowly. The spike measures this. Sub-realtime is acceptable because map segments are a small fraction of the film.
- **Map never idle.** A missing tile can stall `idle`. Every frame wait has a timeout and captures anyway.
- **4K decode time.** Scoring a 40-clip trip means decoding every clip once. Run it as a background job at ingest, not on demand.
- **Transcription of place names.** Mitigated by the gazetteer prompt. Show the transcript and let the owner fix words before anchoring.
- **Music copyright.** YouTube may claim or mute the track. This is the owner's choice per film; the tool warns once.
- **Studio regression.** Promoting the replay and camera into a shared module touches a working app. Studio's existing tests in `tests/` must keep passing and the demo grid must look identical.

## Testing

- **Camera driver:** headless `.mjs` tests beside the existing `tests/*.test.mjs`. Given a track and a segment, `poseAt` at t=0 and t=dur matches the endpoints, zoom follows the curve, output is identical across calls.
- **EDL transforms:** rough cut, recut rules, beat snap are pure functions over JSON. Unit test each rule with a fixture EDL and a fixture transcript.
- **Scoring:** fixture clips under `core/rust/samples/` with known "good" windows; assert the proposal lands inside them.
- **Render smoke:** a 10 second 360p film from a fixture ride, run locally and in CI where ffmpeg is present. Assert duration, resolution, and that the audio track exists.
- **Proof for the PR:** a rendered film from a real trip, linked from the PR, per the repo's "show proof" rule.

## Out of scope for the first version

Vertical reel framing, a multi-track timeline editor, a music library, generated music, GoPro or DJI telemetry parsing, publishing directly to YouTube.
