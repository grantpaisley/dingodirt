# Dingo UI Filters & Graph Specification

*2025-12-29*

---

## Overview

This document extends the UI specification. It adds filter controls to find
similar rides, a bottom graph pane for detailed analysis, and a settings page
for user customization.

---

## Filter Controls

### Location

The top of the left pane, or a map overlay. There are two distinct control
groups:

1. **Color control** — sets the line rendering style
2. **Filter control** — sets which runs/sections are highlighted

---

### Color Control (HR/Speed Toggles)

**Purpose:** Control how the track lines are colored.

| Toggle | Behavior |
|--------|----------|
| HR | Color by the heart rate gradient |
| Speed | Color by the speed gradient |
| Both off | Color by mode |

- Only one can be active at a time
- When you select HR, Speed turns off (and vice versa)
- Click to toggle on; click again to toggle off

---

### Mode Filter

**Structure:**

```
Mode ▼
  [x] ADV
  [x] Enduro
  [ ] MTB
  [ ] eUnicycle
  [ ] Other
```

- Click "Mode" to expand the submenu
- A second click collapses the submenu
- Each mode is a toggle (show or hide the runs of that mode)
- Multiple modes can be active at the same time

---

### Range Filter (Separate Icon)

**Access:** The filter icon expands to show the sliders

**Purpose:** Find runs with a similar effort or pace. The filter also
highlights the portions of tracks that satisfy it.

**Controls:**

| Slider | Type | Description |
|--------|------|-------------|
| HR avg | Dual-handle (min-max) | Filter by the average heart rate |
| HR max | Dual-handle (min-max) | Filter by the max heart rate |
| Speed avg | Dual-handle (min-max) | Filter by the average speed |
| Speed max | Dual-handle (min-max) | Filter by the max speed |

**Behavior:**

- Runs inside all active ranges → highlighted (full color)
- Runs outside any range → greyed out
- Sections of tracks inside the range → highlighted
- Sections outside the range → greyed out
- The slider ranges auto-populate from the visible runs (min/max values)

**Use case:** "Show me rides where I averaged 130-140 bpm and 15-20 km/h" →
the UI highlights the rides with a similar effort and greys out the rest.

---

## Bottom Pane — Graph View

### Layout

**Location:** The bottom of the screen, below the map pane

**Behavior:**

- Collapsible (a toggle button)
- Resizable (drag the top edge)
- Shows when one or more runs are selected

### Structure

```
┌─────────────────────────────────────────────────────────┐
│ Info Bar: Distance: 12.4 km | HR: 132 bpm | Speed: 19 km/h │
├─────────────────────────────────────────────────────────┤
│                                                         │
│                      Graph                              │
│   HR (left Y)                           Speed (right Y) │
│                                                         │
│                    Distance (X)                         │
└─────────────────────────────────────────────────────────┘
```

### Info Bar

**Location:** The top of the bottom pane

**Content:**

| Field | Display |
|-------|---------|
| Distance | km from the run start, at the cursor position |
| HR | bpm at the cursor position |
| Speed | km/h at the cursor position |

**Values:**

- A single run hovered: exact values (12.4 km, 132 bpm, 19 km/h)
- Multiple runs at the cursor (no specific hover): a range (12.4 km, 120-124 bpm, 18-22 km/h)

### Graph

**Axes:**

| Axis | Data |
|------|------|
| X | Distance (absolute, from the run start) |
| Left Y | Heart rate (bpm) |
| Right Y | Speed (km/h) |

**Lines:**

- One line per selected run
- All lines have the same color until hovered
- HR and Speed are separate line types (solid vs dashed, or a dual line per run)

**Future enhancement:** When a segment is selected, the X-axis aligns the runs
to the segment start. The system GPS-matches the runs and shifts them to align
at segment distance zero.

---

## Interaction — Visual States

### Map States

| State | Appearance |
|-------|------------|
| Not selected | Greyed out / washed out |
| Selected | Full color (by mode, HR, or speed, as the color control sets) |
| Hover (within selected) | Highlighted (glow/thicker) + a point marker at the cursor position |
| Filtered out (outside slider ranges) | Greyed out |
| Partially filtered | Full color on the sections in range; the rest is greyed |

### Graph States

| State | Appearance |
|-------|------------|
| Selected (not hovered) | All lines show, in the same color |
| Hover | The hovered line highlights; the other lines fade |

### Bidirectional Linking

| Action | Result |
|--------|--------|
| Hover a line on the graph | The line highlights; the matching run highlights on the map; a point marker shows on the map at the position |
| Hover a run on the map | The run's line highlights on the graph; a point marker shows on the graph at the matching distance; the info bar updates |
| Move the cursor along the graph | The point marker moves on the map; the info bar updates |
| Move the cursor along a run on the map | The point marker moves on the graph; the info bar updates |

Map ↔ Graph ↔ Info bar are all synchronized.

---

## Settings Page

**Access:** The cog icon opens a settings modal or a dedicated page

---

### Heart Rate Color Scale

The boundaries are user-adjustable. The gradients interpolate between the
boundaries.

| BPM Range | Color | RGB |
|-----------|-------|-----|
| < 108 | Blue | (0, 0, 255) |
| 108-126 | Blue → Cyan | (0, 0→255, 255) |
| 126-145 | Cyan → Green | (0, 255, 255→0) |
| 145-163 | Green → Yellow | (0→255, 255, 0) |
| > 163 | Red | (255, 0, 0) |
| null | Gray | (128, 128, 128) |

---

### Speed Color Scale

The boundaries are user-adjustable. The gradients interpolate between the
boundaries.

| Speed Range | Color | RGB |
|-------------|-------|-----|
| 0-5 km/h | Purple → Blue | (128→0, 0, 128→255) |
| 5-15 km/h | Blue → Cyan | (0, 0→255, 255) |
| 15-30 km/h | Cyan → Green | (0, 255, 255→0) |
| 30-80 km/h | Green → Yellow | (0→255, 255, 0) |
| > 80 km/h | Yellow | (255, 255, 0) |
| null | Gray | (128, 128, 128) |

---

### Map Settings

| Setting | Options | Default |
|---------|---------|---------|
| Default basemap | Satellite / Topo / Hybrid | Satellite |
| Tile cache size | MB limit | 500 MB |
| Default corridor width | Meters | 5 m |

---

### Display Settings

| Setting | Options | Default |
|---------|---------|---------|
| Units | Metric / Imperial | Metric |
| Date format | DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD | DD/MM/YYYY |
| Default color mode | Mode / HR / Speed | Mode |

---

### Performance Settings

| Setting | Options | Default |
|---------|---------|---------|
| Simplification level | Low / Medium / High detail | Medium |
| Max visible runs | A limit for performance | 1000 |

---

### Data Settings

| Setting | Options | Default |
|---------|---------|---------|
| Default ride mode | ADV / Enduro / MTB / eUnicycle / Other | Enduro |
| Auto-assign mode by device | On/Off + device mappings | Off |
| Ingest watch folder | Path | ~/Downloads |

---

### Routing Settings (Valhalla)

| Setting | Options | Default |
|---------|---------|---------|
| Default routing profile | Road / Cycling / MTB | MTB |
| Prefer paved | Slider (0-100%) | 20% |
| Avoid highways | On/Off | On |

---

## Summary

| Component | Purpose |
|-----------|---------|
| Color control | HR / Speed / Mode coloring of the lines |
| Mode filter | Show or hide by ride mode |
| Range filter | Highlight the runs/sections that match the HR/Speed criteria |
| Bottom graph pane | Distance vs HR/Speed, linked to the map |
| Info bar | The current values at the cursor position |
| Settings | User customization of colors, units, and performance |

All interactions are bidirectional: the map, the graph, and the info bar stay
synchronized.
