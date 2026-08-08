# Dingo UI Specification

*2025-12-29*

---

## Overview

This is a segment-centric trail management interface. Use it to define,
organize, and plan off-road rides. The user defines the segments; the system
does not auto-discover them. The UI must handle thousands of runs with high
point counts and stay responsive.

---

## Core Concept

**Segments are user-defined:**
- The user selects runs and marks the start/end points
- The system creates a segment with a consensus geometry (averaged from the selected runs)
- The system does no automatic graph building

**Run states:**
- Associated — linked to ≥1 segment (shown in full color)
- Unassociated — not yet linked (shown washed-out)

---

## Layout

```
┌─────────────┬────────────────────────────┬─────────────┐
│   Left      │                            │   Right     │
│   List      │         Map                │   Detail    │
│   Pane      │                            │   Pane      │
│             │                            │             │
│ (collapsible)                            │(collapsible)│
└─────────────┴────────────────────────────┴─────────────┘
```

---

## Left Pane — List

**Purpose:** Browse and filter runs, segments, and routes.

**Controls:**

| Element | Behavior |
|---------|----------|
| Toggle | Runs / Segments / Routes / All |
| Search box | A natural language query (vector search via LanceDB) |
| Date range picker | A structured filter, ANDed with the search |
| List rows | One compact line per item |

**Row elements:**

| Element | Behavior |
|---------|----------|
| Visibility icon | Click to show or hide the item on the map |
| Zoom icon | Click to zoom the map to the item bounds |
| Name/date | The primary identifier |
| Association indicator | A dot or badge for unassociated runs |

**Behavior:**
- Click a row → show or hide the item on the map
- Multi-select is supported (shift-click, cmd-click)
- Unassociated runs look distinct (lighter text, a badge)
- Search results update the list and the map at the same time

---

## Right Pane — Detail

**Purpose:** Show the details for the hovered or selected item. Segments and
routes have editable fields.

### Run Details

| Field | Description |
|-------|-------------|
| Date/time | When the run was recorded |
| Distance | Total km |
| Duration | Total time |
| Elevation gain/loss | Meters |
| Avg/max speed | km/h |
| Avg/max HR | bpm (if available) |
| Condition | Dry / Wet / Unknown |
| Mode | ADV / Enduro / eBike |

### Segment Details

| Field | Description |
|-------|-------------|
| Name | Editable inline |
| Length | Meters |
| Elevation gain/loss | Per direction |
| Run count | The number of linked runs |
| Last ridden | Date |
| Direction | A→B or B→A; the user can override it |
| Corridor width | A display setting |

### Route Details

| Field | Description |
|-------|-------------|
| Name | Editable; the default comes from a template (start → end) |
| Total distance | Segments + bridges |
| Total elevation | The sum |
| Estimated time | Based on the historical data |
| Time range | Min/max from the runs |
| Wet/dry breakdown | Stats per condition |
| Segment list | Ordered, with directions |
| Notes | Editable |

### Graphs (all detail views)

| Graph | Description |
|-------|-------------|
| Elevation profile | X = distance or time (toggle), Y = elevation |
| HR line graph | X = distance or time (toggle), Y = heart rate |

**Linked interaction:**
- Hover on the graph → the map highlights the point
- Hover on the map → the graphs highlight the point

---

## Map Pane — Center

**Purpose:** The primary interaction area. Display and manipulate runs,
segments, and routes.

### Technology

| Component | Choice |
|-----------|--------|
| Basemap | MapLibre GL JS |
| Data layers | Deck.gl PathLayer |
| Tile caching | Online, with a local cache |

### Basemap Options

- Satellite imagery
- Topo/contour
- Hybrid (satellite + topo overlay)
- The user switches via a control

### Visual Options (Cog Menu)

**Color by:**
- None (solid color)
- Heart rate
- Speed
- Elevation
- Gradient (slope)

The color scale is global (min/max across all visible items).

**Filter by direction:**
- All
- Northbound (end lat > start lat)
- Southbound
- Eastbound
- Westbound

**Show/hide:**
- Runs (associated)
- Runs (unassociated)
- Segments
- Segment direction arrows

**Other:**
- Segment corridor width

### Visual Hierarchy

| Item | Appearance |
|------|------------|
| Associated runs | Full color (by the selected color mode) |
| Unassociated runs | Washed-out / desaturated |
| Selected items | Full color + a highlight (a glow or a thicker stroke) |
| Segments | A distinct style, with a corridor buffer |
| Routes | Segments + dashed bridges |

---

## Interactions

### Selection

| Action | Behavior |
|--------|----------|
| Click run/segment | Toggle the selection |
| Lasso drag | Select all items that the lasso touches |
| Lasso visual feedback | Runs "light up" to full color as the lasso touches them |
| Shift-click | Add to the selection |
| Escape | Clear the selection |

### Segment Creation

| Step | Action |
|------|--------|
| 1 | Select runs (click or lasso) |
| 2 | Click the start point on the map |
| 3 | The marker snaps to the nearest point on the selected runs |
| 4 | Click the end point on the map |
| 5 | The marker snaps; the system creates the segment immediately |
| 6 | The right pane shows the segment details; the name is editable |
| 7 | Drag the markers to refine the start/end if needed |

**Geometry:**
- The system averages the consensus centerline from the selected runs
- A fixed-width corridor buffer is used for display
- The click order defines the A→B direction (override it in the right pane)

### Segment Editing

**Link/unlink runs:**

| Step | Action |
|------|--------|
| 1 | Select the segment |
| 2 | Select one or more runs |
| 3 | Click "Link to segment" or "Unlink from segment" |
| 4 | The system updates the associations and recalculates the stats |

**Split segment:**

| Step | Action |
|------|--------|
| 1 | Select the segment |
| 2 | Click the "Split" action |
| 3 | Click the point on the segment where the split occurs |
| 4 | The system creates two new segments and deletes the original |
| 5 | The system re-associates the runs by geometry coverage |
| 6 | The system flags routes that contain the original segment for review |

### Route Creation

| Step | Action |
|------|--------|
| 1 | Select multiple segments (click or lasso) |
| 2 | The right pane shows the route preview immediately |
| 3 | The system auto-generates the bridge routes via Valhalla (OSM data) |
| 4 | The bridges show dashed, in a distinct color |
| 5 | Click a bridge to add a waypoint; drag the waypoint to adjust the route |
| 6 | Delete the waypoint to revert to the direct route |
| 7 | The name is editable (default: the start → end template) |
| 8 | Save to create the route entity |

**Bridge editing:**
- Click on a bridge → the system adds a draggable waypoint
- Drag the waypoint → Valhalla re-routes through it
- Delete the waypoint → the system recalculates the route without it

---

## Performance Architecture

### Multi-Resolution Geometry

| Level | Use |
|-------|-----|
| `geometry_z10` | Zoomed out, aggressive simplification |
| `geometry_z14` | Mid zoom, moderate detail |
| `geometry_full` | Close zoom, the stats, the detail pane |

The system generates these on ingest and stores them as columns on the runs
table.

### Rendering Pipeline

1. On map load: fetch the simplified geometries for the visible bounds
2. On zoom in: swap to a higher resolution
3. On zoom out: swap to a lower resolution
4. Use the full resolution only for the detail pane, the stats, and segment creation

### Lasso Performance

- Deck.gl GPU picking does the intersection tests
- Fast, even with thousands of paths
- The client manages the selection state

### Tile Caching

- The system caches basemap tiles locally after the first fetch
- The map works offline for areas viewed before

---

## Search & Filtering

### Vector Search

- The user types natural language: "muddy climbs near Beerburrum"
- A local model embeds the query (all-MiniLM-L6-v2, ~80MB)
- A LanceDB similarity search returns the matches
- The results filter both the list pane and the map

### Structured Filters

- A date range picker
- ANDed with the vector search results
- Future: area, condition, and mode dropdowns

### Embedding

On ingest/segment creation:
- Embed the metadata (name, tags, area, conditions, stats)
- Store the embedding in LanceDB
- Query it at search time

---

## Route Planning

### Bridge Routing

| Component | Choice |
|-----------|--------|
| Engine | Valhalla (local) |
| Data | An OpenStreetMap extract |
| Profiles | Cycling, MTB (configurable) |

### Time Estimates

| Source | Usage |
|--------|-------|
| Historical run data | Per segment, per mode, where available |
| Valhalla defaults | For the bridges |
| Fallback | A default pace if no data exists |

**Display:**
- The estimated time (the best guess)
- The range (min/max from the actual runs)

---

## Data Model Additions

### Route Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | The primary key |
| `name` | TEXT | User-provided or generated |
| `segment_ids` | UUID[] | An ordered list |
| `segment_directions` | TEXT[] | A→B or B→A per segment |
| `bridge_geometries` | GEOMETRY[] | The connector lines |
| `bridge_waypoints` | JSONB | The user waypoints per bridge |
| `total_distance` | REAL | Computed |
| `total_elevation` | REAL | Computed |
| `estimated_time` | INTERVAL | Computed |
| `time_range_min` | INTERVAL | From the runs |
| `time_range_max` | INTERVAL | From the runs |
| `created_at` | TIMESTAMPTZ | |
| `notes` | TEXT | Optional |

### Run Table Additions

| Field | Type | Description |
|-------|------|-------------|
| `geometry_z10` | GEOMETRY | Simplified for zoom 10 |
| `geometry_z14` | GEOMETRY | Simplified for zoom 14 |

### Segment Table Additions

| Field | Type | Description |
|-------|------|-------------|
| `corridor_width` | REAL | The display buffer width (meters) |

---

## Future Enhancements

- Variable-width segment corridors (per-vertex width from the run spread)
- Run-weighted bridge routing (prefer the roads you have ridden)
- Offline Valhalla with regional OSM extracts
- Segment merge (combine two adjacent segments)
- Route export to GPS device formats
