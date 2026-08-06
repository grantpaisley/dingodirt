# Segment Naming Specification

*Guidelines for generating memorable, locally-grounded trail segment names*

---

## Overview

Generate quirky, memorable segment names that blend local context with trail character. Names should feel like they came from a local rider, not a GPS unit.

---

## Input Data (Priority Order)

Use the richest available context, falling back through the list:

1. **Nearby POI** (< 200m) — gates, lookouts, dams, towers, bridges, quarries, cemeteries, servos, etc.
2. **Intersecting/parallel road or track name** — fire trails, old coach roads, boundary tracks, powerline easements
3. **Nearby landmark** — mountains, peaks, creeks, ridgelines, state forest names
4. **Area name** — Beerburrum, Glasshouse, D'Aguilar, etc.
5. **What3words** — fallback only when nothing else available

---

## Trail Character Descriptors

Derive from segment geometry, stats, and photo labels:

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

Select template based on available data:

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

Use sparingly — only when segment has a truly distinctive character.

### Template 6: What3words (fallback only)
`{what3words address}`

Only use when no other context available. Flag for user review.

---

## Name Generation Rules

1. **Keep it short** — 2-4 words max
2. **Aussie English preferred** — "Servo" not "Gas Station", "Ute Track" not "Truck Trail"
3. **No generic GPS names** — Never "Segment 47" or "Trail Section 3"
4. **Direction-aware** — If character differs by direction, name can reflect dominant direction (e.g., "Quarry Drop" even though it's "Quarry Climb" the other way)
5. **Avoid duplication** — Check existing segment names in area before assigning
6. **Flag low-confidence names** — If falling back to Template 4-6, mark as `name_confidence: low` for user review

---

## Condition-Based Modifiers (Optional)

For segments with dramatically different wet/dry character, consider condition-aware naming:

- "Dustbowl" (dry) vs same segment might be "Boghole" (wet) — but store as single name, note condition behaviour in description instead

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

- Run name generation after segment creation and initial stats/photo analysis
- Re-evaluate name if POI added nearby or road data imported
- Store `name_source` enum: `poi`, `road`, `landmark`, `area`, `character`, `what3words`, `user`
- Store `name_confidence`: `high`, `medium`, `low`
- User override always wins — set `name_source: user` and never auto-regenerate

---

## User Review Queue

Segments needing name review:
- `name_confidence: low`
- `name_source: what3words`
- Name collision with existing segment
- User flagged for rename
