# DingoNav settings reference

This page lists each setting that you can change, grouped by where it lives.
The **Context** column tells how a setting interacts with the two big modes:
**ride mode** (Vehicle: Walk / MTB / Enduro / ADV) and **map type** (Day =
Day·Trail styles, Night = Dark·Sat).

There are three tiers:

1. **Settings tabs** — the everyday choices.
2. **Advanced tab** (Settings → General → Show advanced) — the tuning knobs,
   with a per-row reset. **Export config** captures all of them for
   bench-tuning on a desktop.
3. **Automatic day/night behaviours** — these are not knobs; they follow the
   map style.

---

## 1 · Everyday settings (Settings tabs)

| Setting | Tab | Type · options | Default | Context |
|---|---|---|---|---|
| Map layers | General | Day · Trail · Dark · Sat | Day | **Is** the map type — drives every day/night behaviour below |
| Terrain shading | General | toggle | on | Day styles only (Dark/Sat skip hillshade) |
| Strava heatmap overlay | General | toggle | off | needs bundle tiles |
| Your name / Email | Account | text | — | global |
| Ride name | Tracks | text | — | global (live group sync topic) |
| Keep screen on while navigating | General | toggle | on | global |
| Ride controls button on the right | General | toggle | left | global |
| Control buttons on | General | sides · top/bottom | sides | global |
| Show advanced tab | General | toggle | off | global |
| Turn beeps | Nav | toggle | on | global |
| Departure chime (turn done) | Nav | toggle | on | global |
| **Vehicle (a track's own type overrides)** | Nav | Walk · MTB · Enduro · ADV | Enduro | The **fallback** ride mode. A pack track carries its own type (adv / enduro / mtb) and that picks the profile while it is being navigated; loose GPX, typeless tracks and Explore use this setting — see §4 |
| Auto-zoom | Nav | toggle | on | zoom presets stored per vehicle |
| Compass when zoomed in | Nav | Turns · Zoom · Off | Turns | global |
| Countdown units | Nav | Metres · Seconds | Metres | global |
| Road-surface patterns | Nav | toggle | on | global |
| Backtrack trail | Nav | toggle | on | global |
| Bike telemetry / Source / Server URL | Stark | toggle · VP/BLE · text | off | Stark profile |
| Hardware key bindings | Keys | per-key | defaults | global |

---

## 2 · Advanced tuning knobs

### Route line

| Setting | Default | Range | Context |
|---|---|---|---|
| Route width zoomed out (px) | 6 | 2–14 | global (total width at overview zoom) |
| Route width zoomed in (px) | 11 | 4–20 | global (total width at nav zoom) |
| Core share of route width | 0.67 | 0.4–0.95 | global (case:core ratio) |
| Route casing | Auto | Auto · Dark · White | **Auto = dark case on Day maps, white on Night** |
| Dash gaps | Casing colour | Casing colour · See-through | global |
| Route colour | `#4AA8FF` | colour | global (day & night) |
| Dirt dash / gap (×width) | 2.4 / 1.4 | 0.5–8 / 0.2–8 | global |
| Singletrack dash / gap (×width) | 1.2 / 0.9 | 0.05–4 / 0.2–8 | global |

### Progress states (travelled / missed / recent)

| Setting | Default | Range | Context |
|---|---|---|---|
| Travelled route core | `#7F8791` | colour | global |
| Travelled route casing | `#1A1E24` | colour | global (does not day/night swap) |
| Travelled route opacity | 0.5 | 0.1–1 | global |
| Missed section opacity | 0.5 | 0.1–1 | global (uncased by design) |
| Recent band length (m) | 75 | 0–300 | global (mid-ride only) |
| Recent band opacity | 0.8 | 0.1–1 | global |
| Progress continuity gap (m) | 150 | 50–400 | global (bigger = more forgiving GPS dropouts) |
| Ride archive simplify (m) | 10 | 2–40 | global (Douglas-Peucker on STOP) |

### Symbols (direction Vs · slope chevrons · turn arrow)

| Setting | Default | Range | Context |
|---|---|---|---|
| Direction V size (0 off) | 15 | 0–30 | drawn in casing colour → follows day/night case |
| Direction V spacing | 90 | 30–300 | global |
| Slope chevron size (0 off) | 16 | 0–30 | casing colour → follows day/night |
| Slope chevron spacing (m) | 70 | 20–200 | global |
| Steep grade threshold (%) | 10 | 4–20 | global (single `^`) |
| Very steep grade threshold (%) | 17 | 8–35 | global (double `^^`) |
| Turn arrow fill | `#ffb020` | colour | global |
| Turn arrow opacity | 0.55 | 0.2–1 | global |
| Turn arrow surround / width | `#101820` / 0 (off) | colour / 0–4 | global |

### Audio & chimes

| Setting | Default | Range | Context |
|---|---|---|---|
| Beep volume | 0.5 | 0–1 | global |
| Approach tone (Hz) | 460 (deep) | 200–800 | global |
| Turn tone (Hz) | 990 (high) | 600–1600 | global |
| Approach chime by | Seconds | Seconds · Metres | seconds mode is speed-scaled, **clamped per vehicle** (§4) |
| Approach seconds / metres | 15 s / 250 m | 5–40 / 50–800 | whichever unit is active |
| Departure chime by | Metres | Metres · Seconds | global |
| Departure metres / seconds past turn | 30 m / 4 s | 10–200 / 1–20 | global |

### Alerts, cues & track lock — **per-vehicle** (edits apply to the selected vehicle)

| Setting | Default (Enduro) | Range | Context |
|---|---|---|---|
| Far warn min / max (m) | 60 / 250 | 10–300 / 40–800 | **per vehicle** — see §4 |
| Near warn min / max (m) | 25 / 70 | 5–150 / 15–300 | **per vehicle** |
| Approach window ×far | 1.5 | 1–4 | global (camera framing) |
| Approach floor (m) | 250 | 100–600 | global |
| Lock position to track | off (ADV: **on**) | toggle | **per vehicle** — Google-Maps style: the dot, arrow and camera sit on the track while on it; the breadcrumb and accuracy circle stay on the raw fix. Design: `docs/plans/2026-09-06-nav-track-lock-design.md` |
| Off-track beyond (m) | 60 (ADV: 50) | 20–200 | **per vehicle**. With lock on, a fix past this only counts if its accuracy circle cannot reach the track, or it has stayed past for 2 s |
| Back on within (m) | 40 (ADV: 30) | 10–150 | **per vehicle** — no guard on the way back |

### Compass & camera

| Setting | Default | Range | Context |
|---|---|---|---|
| Heading damping | 0.12 | 0.02–0.5 | global (doubles when stopped) |
| Heading dead-band (°) | 2 | 0–8 | global |
| Map rotation rate (Hz) | 4 | 1–20 | global |
| Follow ease (ms) | 900 | 200–2000 | global |
| Compass zoom threshold | 15 | 10–18 | used by "Compass when zoomed in: Zoom" |

### Zoom & countdown

| Setting | Default | Range | Context |
|---|---|---|---|
| Countdown from (m) | 300 | 100–1000 | global |
| Zoom presets (min/med/max) | per vehicle | hold a preset button to capture | **per vehicle** |

### Rendering & misc

| Setting | Default | Range | Context |
|---|---|---|---|
| Riding button opacity | 0.4 | 0.1–1 | **Night styles only** — Day maps force full opacity |
| Trail dot spacing (m) | 20 | 5–100 | global (breadcrumb) |
| Heatmap: own rides | `#ff7a00` | colour | incl. archived rides |
| Heatmap: other riders / planned | `#ff2d2d` / `#3390ff` | colour | global |
| Basemap minor trails colour / width × | `#909090` / 1 | colour / 0.3–3 | **Trail map style only** |
| GPS accuracy floor (m, 0 off) | 0 | 0–100 | global |

---

## 3 · Automatic day/night behaviours (follow the map style, not knobs)

| Token | Day (Day · Trail) | Night (Dark · Sat) |
|---|---|---|
| Route casing (on Auto) | dark `#101820` — reads as shadow | white — reads as glow |
| UI accent | macOS blue `#007AFF` | cyan `#00e5ff` |
| Control plates / ☰ / dot-square | Mac light `#f5f5f7`, dark glyphs | dark `rgba(22,28,34)`, white glyphs |
| Speed & mode readouts | near-black + light halo | white + dark shadow |
| Countdown amber / off-route red | darkened `#b45309` / `#c22a2a` | `#ffb020` / `#ff4545` |
| Turn strip | frosted white, dark text | dark translucent, light text |
| Bottom bar + slide-up panel | white / light grey, Mac controls | original dark |
| Riding control fade | none (always full) | ghost to *Riding button opacity* |
| ☰ tile grid, toasts | dark always | dark always |

---

## 4 · Per-vehicle values (ride mode matrix)

| | Walk | MTB | Enduro | ADV |
|---|---|---|---|---|
| Far warn min–max (m) | 25–60 | 40–150 | 60–250 | 120–400 |
| Near warn min–max (m) | 10–30 | 15–50 | 25–70 | 40–100 |
| Default speed (m/s) | 1.4 | 4 | 8 | 14 |
| Lock position to track | off | off | off | **on** |
| Off-track beyond / back on within (m) | 60 / 40 | 60 / 40 | 60 / 40 | 50 / 30 |
| Auto-zoom spans (m at speed steps) | 150→400 | 250→900 | 300→2500 | 400→7000 |
| Zoom presets (min/med/max) | per vehicle, hold-to-set | ” | ” | ” |
| Advanced far/near overrides | stored per vehicle | ” | ” | ” |

The approach chime in **Seconds** mode = speed × seconds, clamped into the
far min–max window of the vehicle. **Metres** mode ignores the vehicle.

Which column applies is decided per ride: a pack track's own type (`adv` →
ADV, `enduro` → Enduro, `mtb` → MTB) wins while that track is being
navigated; otherwise the Vehicle setting. Going off track releases approach
zoom and settles at the riding (max) zoom for every column — it never zooms
in while you are off.

---

*Each setting in §2 lives in `S.set.adv`, and it round-trips through
Settings → Export config. The per-vehicle overrides live under
`adv.veh.<vehicle>`. A new app version replaces the saved screen-layout
config (the v4 rule), but it never touches these settings.*
