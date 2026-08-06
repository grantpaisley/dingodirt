# Dingo UI Filters & Graph Specification

*2025-12-29*

---

## Overview

Extends the UI specification with filter controls for finding similar rides, a bottom graph pane for detailed analysis, and a settings page for user customization.

---

## Filter Controls

### Location

Top of left pane or map overlay. Two distinct control groups:

1. **Color control** — determines line rendering style
2. **Filter control** — determines which runs/sections are highlighted

---

### Color Control (HR/Speed Toggles)

**Purpose:** Control how track lines are colored.

| Toggle | Behavior |
|--------|----------|
| HR | Color by heart rate gradient |
| Speed | Color by speed gradient |
| Both off | Color by mode |

- Only one can be active at a time
- Selecting HR turns off Speed (and vice versa)
- Click to toggle on, click again to toggle off

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

- Click "Mode" to expand submenu
- Second click collapses submenu
- Each mode is a toggle (show/hide runs of that mode)
- Multiple can be active simultaneously

---

### Range Filter (Separate Icon)

**Access:** Filter icon expands to show sliders

**Purpose:** Find runs with similar effort/pace. Also highlights portions of tracks that satisfy the filter.

**Controls:**

| Slider | Type | Description |
|--------|------|-------------|
| HR avg | Dual-handle (min-max) | Filter by average heart rate |
| HR max | Dual-handle (min-max) | Filter by max heart rate |
| Speed avg | Dual-handle (min-max) | Filter by average speed |
| Speed max | Dual-handle (min-max) | Filter by max speed |

**Behavior:**

- Runs within all active ranges → highlighted (full color)
- Runs outside any range → greyed out
- Sections of tracks within range → highlighted
- Sections outside range → greyed out
- Slider ranges auto-populate from visible runs (min/max values)

**Use case:** "Show me rides where I averaged 130-140 bpm and 15-20 km/h" → similar effort rides highlighted, dissimilar greyed out.

---

## Bottom Pane — Graph View

### Layout

**Location:** Bottom of screen, below map pane

**Behavior:**

- Collapsible (toggle button)
- Resizable (drag top edge)
- Shows when one or more runs selected

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

**Location:** Top of bottom pane

**Content:**

| Field | Display |
|-------|---------|
| Distance | km from run start at cursor position |
| HR | bpm at cursor position |
| Speed | km/h at cursor position |

**Values:**

- Single run hovered: exact values (12.4 km, 132 bpm, 19 km/h)
- Multiple runs at cursor (no specific hover): range (12.4 km, 120-124 bpm, 18-22 km/h)

### Graph

**Axes:**

| Axis | Data |
|------|------|
| X | Distance (absolute from run start) |
| Left Y | Heart rate (bpm) |
| Right Y | Speed (km/h) |

**Lines:**

- One line per selected run
- All lines same color until hovered
- HR and Speed as separate line types (solid vs dashed, or dual-line per run)

**Future enhancement:** When segment selected, X-axis aligns runs to segment start (GPS-matched, runs shifted to align at segment distance zero).

---

## Interaction — Visual States

### Map States

| State | Appearance |
|-------|------------|
| Not selected | Greyed out / washed out |
| Selected | Full color (by mode, HR, or speed depending on color control) |
| Hover (within selected) | Highlighted (glow/thicker) + point marker at cursor position |
| Filtered out (outside slider ranges) | Greyed out |
| Partially filtered | Full color on sections within range, rest greyed |

### Graph States

| State | Appearance |
|-------|------------|
| Selected (not hovered) | All lines shown, same color |
| Hover | Hovered line highlighted, others fade |

### Bidirectional Linking

| Action | Result |
|--------|--------|
| Hover line on graph | Line highlights; corresponding run highlights on map; point marker on map at position |
| Hover run on map | Run's line highlights on graph; point marker on graph at matching distance; info bar updates |
| Move cursor along graph | Point marker moves on map; info bar updates |
| Move cursor along run on map | Point marker moves on graph; info bar updates |

Map ↔ Graph ↔ Info bar all synchronized.

---

## Settings Page

**Access:** Cog icon → opens settings modal or dedicated page

---

### Heart Rate Color Scale

User-adjustable boundaries. Gradients interpolate between boundaries.

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

User-adjustable boundaries. Gradients interpolate between boundaries.

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
| Max visible runs | Limit for performance | 1000 |

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
| Color control | HR / Speed / Mode coloring of lines |
| Mode filter | Show/hide by ride mode |
| Range filter | Highlight runs/sections matching HR/Speed criteria |
| Bottom graph pane | Distance vs HR/Speed, linked to map |
| Info bar | Current values at cursor position |
| Settings | User customization of colors, units, performance |

All interactions are bidirectional: map, graph, and info bar stay synchronized.
