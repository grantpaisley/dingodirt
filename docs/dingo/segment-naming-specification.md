# Segment Naming Specification

*Guidelines to generate memorable trail segment names with local context*

---

## Overview

Generate quirky, memorable segment names. Blend the local context with the
trail character. A name must feel like it came from a local rider, not from a
GPS unit.

---

## Input Data (Priority Order)

Use the richest available context. Fall back through the list:

1. **Nearby POI** (< 200m) — gates, lookouts, dams, towers, bridges, quarries, cemeteries, servos, etc.
2. **Intersecting/parallel road or track name** — fire trails, old coach roads, boundary tracks, powerline easements
3. **Nearby landmark** — mountains, peaks, creeks, ridgelines, state forest names
4. **Area name** — Beerburrum, Glasshouse, D'Aguilar, etc.
5. **What3words** — a fallback only, when nothing else is available

---

## Trail Character Descriptors

Derive the character from the segment geometry, the stats, and the photo labels:

| Character | Source | Examples |
|-----------|--------|----------|
| **Gradient** | avg_grade, elevation_gain | Climb, Pinch, Drop, Descent, Plunge |
| **Technical** | pace_vs_shape, obstacle labels | Boneyard, Rock Garden, Root Maze |
| **Flow** | twistiness, speed_avg | Rollercoaster, Whip, Ribbon, Snake |
| **Surface** | photo labels (mud, sand, rock) | Bog, Sandpit, Slab |
| **Effort** | hr_intensity, slog detection | Grind, Slog, Burner, Drag |
| **Speed** | speed_avg relative to type | Blaster, Cruise, Crawl |
| **Condition** | inferred_condition patterns | Swamp, Dustbowl |
| **Length** | segment length | Short: "Pinch", Long: "Marathon", "Endless" |

---

## Name Structure Templates

Select the template from the available data:

### Template 1: POI + Action (when POI nearby)
`{POI} {Action/Character}`

Examples:
- "Lookout Descent"
- "Dam Wall Climb"
- "Quarry Drop"
- "Cemetery Slog"
- "Tower Run"
- "Gate Pinch"

### Template 2: Road/Track + Character (when road name available)
`{Road/Track Name} {Character}`

Examples:
- "Old Coach Rd Rollercoaster"
- "Boundary Track Boneyard"
- "Powerline Pinch"
- "Fire Trail Grind"

### Template 3: Landmark + Character (when landmark nearby)
`{Landmark} {Character}`

Examples:
- "Ridgeline Ribbon"
- "Creek Crossing Crawl"
- "Gully Grind"

### Template 4: Area + Character (when only area known)
`{Area} {Character}`

Examples:
- "Glasshouse Grind"
- "Beerburrum Burner"
- "D'Aguilar Drag"

### Template 5: Punny/Descriptive (when character is distinctive)
`{Wordplay on character/condition}`

Examples:
- "Mud About You" (consistently muddy)
- "Rock Bottom" (rocky descent)
- "The Bog of Eternal Stench" (notoriously wet)
- "Pinch Me" (short sharp climb)

Use this template rarely. Use it only when the segment has a truly distinctive
character.

### Template 6: What3words (fallback only)
`{what3words address}`

Use this template only when no other context is available. Flag the name for
user review.

---

## Name Generation Rules

1. **Keep it short** — 2-4 words maximum
2. **Aussie English preferred** — write "Servo", not "Gas Station"; write "Ute Track", not "Truck Trail"
3. **No generic GPS names** — never write "Segment 47" or "Trail Section 3"
4. **Direction-aware** — if the character differs by direction, the name can show the dominant direction (e.g. "Quarry Drop", although it is "Quarry Climb" the other way)
5. **Avoid duplication** — check the existing segment names in the area before you assign a name
6. **Flag low-confidence names** — if you fall back to Template 4-6, mark the name as `name_confidence: low` for user review

---

## Condition-Based Modifiers (Optional)

Some segments have a very different wet character and dry character. For these,
consider condition-aware naming:

- "Dustbowl" (dry) — the same segment can be "Boghole" (wet). But store one
  name only. Note the condition behaviour in the description instead.

---

## Examples by Data Availability

| Available Data | Generated Name |
|----------------|----------------|
| POI: "Fire Tower", gradient: steep descent | "Tower Plunge" |
| Road: "Boundary Track", character: technical rocks | "Boundary Boneyard" |
| Landmark: "Cedar Creek", character: crossing + climb | "Cedar Climb" |
| Area: "Beerburrum", character: fast flow | "Beerburrum Blaster" |
| High twistiness + fast + fun | "The Ribbon" |
| Consistently muddy, obstacle: logs | "Bog & Log" |
| Only what3words available | "sliced.purely.frames" (flag for review) |

---

## Implementation Notes

- Run the name generation after segment creation and the initial stats/photo analysis
- Evaluate the name again when you add a POI nearby or import road data
- Store the `name_source` enum: `poi`, `road`, `landmark`, `area`, `character`, `what3words`, `user`
- Store `name_confidence`: `high`, `medium`, `low`
- A user override always wins — set `name_source: user` and never auto-generate the name again

---

## User Review Queue

These segments need a name review:
- `name_confidence: low`
- `name_source: what3words`
- The name collides with an existing segment name
- The user flagged the segment for a rename
