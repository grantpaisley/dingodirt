# Dingo UI Specification

*2025-12-29*

---

## Overview

A segment-centric trail management interface for defining, organizing, and planning off-road rides. Segments are user-defined (not auto-discovered). The UI must handle thousands of runs with high point counts while remaining responsive.

---

## Core Concept

**Segments are user-defined:**
- User selects runs, marks start/end points
- System creates segment with consensus geometry (averaged from selected runs)
- No automatic graph building

**Run states:**
- Associated — linked to ≥1 segment (shown full color)
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
| Search box | Natural language query (vector search via LanceDB) |
| Date range picker | Structured filter, ANDed with search |
| List rows | One line per item, compact |

**Row elements:**

| Element | Behavior |
|---------|----------|
| Visibility icon | Click to show/hide on map |
| Zoom icon | Click to zoom map to item bounds |
| Name/date | Primary identifier |
| Association indicator | Dot or badge for unassociated runs |

**Behavior:**
- Click row → show/hide on map
- Multi-select supported (shift-click, cmd-click)
- Unassociated runs visually distinct (lighter text, badge)
- Search results update list and map simultaneously

---

## Right Pane — Detail

**Purpose:** Show details for hovered or selected item. Editable fields for segments and routes.

### Run Details

| Field | Description |
|-------|-------------|
| Date/time | When recorded |
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
| Run count | Number of linked runs |
| Last ridden | Date |
| Direction | A→B or B→A, user can override |
| Corridor width | Display setting |

### Route Details

| Field | Description |
|-------|-------------|
| Name | Editable, default from template (start → end) |
| Total distance | Segments + bridges |
| Total elevation | Sum |
| Estimated time | Based on historical data |
| Time range | Min/max from runs |
| Wet/dry breakdown | Stats per condition |
| Segment list | Ordered, with directions |
| Notes | Editable |

### Graphs (all detail views)

| Graph | Description |
|-------|-------------|
| Elevation profile | X = distance or time (toggle), Y = elevation |
| HR line graph | X = distance or time (toggle), Y = heart rate |

**Linked interaction:**
- Hover on graph → highlight point on map
- Hover on map → highlight point on graphs

---

## Map Pane — Center

**Purpose:** Primary interaction area. Display and manipulate runs, segments, routes.

### Technology

| Component | Choice |
|-----------|--------|
| Basemap | MapLibre GL JS |
| Data layers | Deck.gl PathLayer |
| Tile caching | Online with local cache |

### Basemap Options

- Satellite imagery
- Topo/contour
- Hybrid (satellite + topo overlay)
- User switches via control

### Visual Options (Cog Menu)

**Color by:**
- None (solid color)
- Heart rate
- Speed
- Elevation
- Gradient (slope)

Color scale: global (min/max across all visible items).

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
| Associated runs | Full color (by selected color mode) |
| Unassociated runs | Washed-out / desaturated |
| Selected items | Full color + highlight (glow or thicker stroke) |
| Segments | Distinct style, corridor buffer |
| Routes | Segments + dashed bridges |

---

## Interactions

### Selection

| Action | Behavior |
|--------|----------|
| Click run/segment | Toggle selection |
| Lasso drag | Select all items touched by lasso |
| Lasso visual feedback | Runs "light up" to full color as lasso touches them |
| Shift-click | Add to selection |
| Escape | Clear selection |

### Segment Creation

| Step | Action |
|------|--------|
| 1 | Select runs (click or lasso) |
| 2 | Click start point on map |
| 3 | Marker snaps to nearest point on selected runs |
| 4 | Click end point on map |
| 5 | Marker snaps, segment created immediately |
| 6 | Right pane shows segment details, name editable |
| 7 | Drag markers to refine start/end if needed |

**Geometry:**
- Consensus centerline averaged from selected runs
- Fixed-width corridor buffer for display
- Click order defines A→B direction (override in right pane)

### Segment Editing

**Link/unlink runs:**

| Step | Action |
|------|--------|
| 1 | Select segment |
| 2 | Select one or more runs |
| 3 | Click "Link to segment" or "Unlink from segment" |
| 4 | Associations updated, stats recalculated |

**Split segment:**

| Step | Action |
|------|--------|
| 1 | Select segment |
| 2 | Click "Split" action |
| 3 | Click point on segment where split occurs |
| 4 | Two new segments created, original deleted |
| 5 | Runs auto-reassociated by geometry coverage |
| 6 | Routes containing original segment flagged for review |

### Route Creation

| Step | Action |
|------|--------|
| 1 | Select multiple segments (click or lasso) |
| 2 | Right pane shows route preview immediately |
| 3 | System auto-generates bridge routes via Valhalla (OSM data) |
| 4 | Bridges shown dashed, distinct color |
| 5 | Click bridge to add waypoint, drag to adjust route |
| 6 | Delete waypoint to revert to direct route |
| 7 | Name editable (default: start → end template) |
| 8 | Save to create route entity |

**Bridge editing:**
- Click on bridge → adds draggable waypoint
- Drag waypoint → Valhalla re-routes through it
- Delete waypoint → route recalculates without it

---

## Performance Architecture

### Multi-Resolution Geometry

| Level | Use |
|-------|-----|
| `geometry_z10` | Zoomed out, aggressive simplification |
| `geometry_z14` | Mid zoom, moderate detail |
| `geometry_full` | Close zoom, stats, detail pane |

Generated on ingest, stored as columns on runs table.

### Rendering Pipeline

1. On map load: fetch simplified geometries for visible bounds
2. On zoom in: swap to higher resolution
3. On zoom out: swap to lower resolution
4. Full resolution only for detail pane, stats, segment creation

### Lasso Performance

- Deck.gl GPU picking for intersection testing
- Fast even with thousands of paths
- Selection state managed client-side

### Tile Caching

- Basemap tiles cached locally after first fetch
- Works offline for previously viewed areas

---

## Search & Filtering

### Vector Search

- User types natural language: "muddy climbs near Beerburrum"
- Query embedded via local model (all-MiniLM-L6-v2, ~80MB)
- LanceDB similarity search returns matches
- Results filter both list pane and map

### Structured Filters

- Date range picker
- ANDed with vector search results
- Future: area, condition, mode dropdowns

### Embedding

On ingest/segment creation:
- Embed metadata (name, tags, area, conditions, stats)
- Store in LanceDB
- Query at search time

---

## Route Planning

### Bridge Routing

| Component | Choice |
|-----------|--------|
| Engine | Valhalla (local) |
| Data | OpenStreetMap extract |
| Profiles | Cycling, MTB (configurable) |

### Time Estimates

| Source | Usage |
|--------|-------|
| Historical run data | Per segment, per mode where available |
| Valhalla defaults | For bridges |
| Fallback | Default pace if no data |

**Display:**
- Estimated time (best guess)
- Range (min/max from actual runs)

---

## Data Model Additions

### Route Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `name` | TEXT | User-provided or generated |
| `segment_ids` | UUID[] | Ordered list |
| `segment_directions` | TEXT[] | A→B or B→A per segment |
| `bridge_geometries` | GEOMETRY[] | Connector lines |
| `bridge_waypoints` | JSONB | User waypoints per bridge |
| `total_distance` | REAL | Computed |
| `total_elevation` | REAL | Computed |
| `estimated_time` | INTERVAL | Computed |
| `time_range_min` | INTERVAL | From runs |
| `time_range_max` | INTERVAL | From runs |
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
| `corridor_width` | REAL | Display buffer width (meters) |

---

## Future Enhancements

- Variable-width segment corridors (per-vertex width from run spread)
- Run-weighted bridge routing (prefer roads you've ridden)
- Offline Valhalla with regional OSM extracts
- Segment merge (combine two adjacent segments)
- Route export to GPS device formats
