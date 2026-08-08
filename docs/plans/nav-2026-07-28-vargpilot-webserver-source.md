# VargPilot webserver source — removed, and how to bring it back

**Status:** removed from the app on 2026-07-28. This document is the complete
record that you need to restore it. The live code is in the git history: the
commit that removed it, and everything before it (search `vpConnect`).

## What it was

DingoNav had **two** telemetry sources for the Stark Varg. A `Source`
segmented control in Settings → Stark selected the source:

| Source | How it got data |
|---|---|
| **VargPilot** (`vargSrc: 'vp'`) | A WebSocket to the built-in BikeStore webserver of VargPilot. That webserver holds the BLE link of the bike and serves the fully decoded telemetry again |
| **Direct BLE** (`vargSrc: 'ble'`) | Web Bluetooth straight to the VCU |

VargPilot was the *preferred* source when we wrote it (2026-07-14): direct
BLE was unproven, and VP had already done the decoding work.

## Why it was removed

Direct BLE now works on the real bike (battery, speed, ride mode, blinkers,
neutral, reverse/crawl, alerts — confirmed 2026-07-28 on Grant's '25 EX).
With two sources, every feature and every status string had two code paths.
The VP path also made the rider find the LAN URL of VP. The rider then had
to keep both devices on the same Wi-Fi, which is fragile at a trailhead.

**Note the subtlety:** the removal of the VP *webserver source* does **not**
stop DingoNav from working with the VargPilot *app*. Direct BLE piggybacks
on the BLE connection of VargPilot — the VCU only streams after VP (or the
stock Stark app) has started the telemetry. The VP app is still part of the
working setup; only its WebSocket source is gone.

## What was lost

1. **hp / regen / TC per-mode values.** These are *configuration* per map,
   not telemetry — they have no known BLE characteristic (and no field in
   the `v1.proto` of `svag-telemetry-format`). Only VP served them. The
   telemetry page now labels them "VP only". To recover them over BLE, you
   must identify the unmapped characteristics (see the "Probe extra
   channels" button).
2. **Automatic VIN + pair-PIN capture** (`vpSniff`). The catalog of VP
   contained both, so one connection to VP pre-configured Direct BLE. Now
   the rider types the VIN one time (and reads the PIN from the UI of VP).
3. **iOS support.** Web Bluetooth is Chrome/Android-only. The VP WebSocket
   worked in any browser. **If iOS support is ever needed, restore this
   source** — that is the single strongest reason to bring it back.

## Protocol (confirmed against live VP 0.1.125, 2026-07)

One WebSocket at `<base>/ws`:

1. The server greets with `{op:'hello'}`
2. The server sends `{op:'catalog', paths:[{path, writable}, …]}`
3. The client sends `{op:'sub', paths:[…]}`
4. The server sends `{op:'prop', path, value, t}` per update
5. The server pings every 15 s (browsers auto-pong — there is nothing to
   implement)

The paths are dot-hierarchical. The subscription is what marks the client
live.

### Path map (verified live on a '25 EX, 2026-07)

```js
const VP_P = {
  soc:  'Battery.SOC.soc_pct',
  soh:  'Battery.SOC.soh_pct',
  vbus: 'Battery.SOC.dc_bus_v',
  mode: 'Live.MAPS.riding_map',
  // ground truth for the reverse/crawl takeover: a human-readable string —
  // "NEUTRAL" / "DRIVE" / "CRAWL REV" (reverse) / "CRAWL FWD" (crawl).
  drive: 'derived.power.drive_state',
  walk:  'Bike.STATUS_BITS.misc_bits.walking_mode', // fallback: 8 = rev, 12 = crawl
  blinkerL: 'Bike.STATUS_BITS.indicator_bits.blinker_left',  // toggles ~3 Hz with the bulb
  blinkerR: 'Bike.STATUS_BITS.indicator_bits.blinker_right',
  beam:     'Bike.STATUS_BITS.indicator_bits.beam_long',     // steady while high beam on
};

// per-mode config: "torque" is the power (hp) slider on the EX
const vpMapPaths = m => [
  ['Vcu.BIKE_CONFIG.MAP.' + m + '.torque', 'hp',    m],
  ['Vcu.BIKE_CONFIG.MAP.' + m + '.regen',  'regen', m],
  ['derived.tc.' + m + '.power_tc',        'tc',    m],
];
```

The BLE status characteristic (`00001002`) carries these same `STATUS_BITS`
words — VP just decodes them for you. We **confirmed the `walking_mode`
values 8 = reverse and 12 = crawl on the bike through VP**. That is the
source of the values in the BLE decoder.

### Decode notes worth keeping

- `drive_state` is authoritative for reverse/crawl/neutral. `walking_mode`
  was only a fallback for when `drive_state` never arrived (the
  `vp.sawDrive` flag).
- The blinker paths pulse true/false at ~3 Hz with the bulb. Only the
  `true` pulses matter — feed them to `vargBlink(side)`. Its watchdog
  (`BLINK_OFF_MS` 700 ms) collapses the pulses into a steady telltale. That
  debounce logic is still in the app; the BLE status decoder uses it.
- URL normalising: prepend `http://` if absent. Strip the trailing slashes.
  Then swap `http` → `ws` for the socket (`vpUrlBase()`).
- The reconnect was a flat 3 s retry on `onclose`.

## To re-enable

1. Restore the `S.set` keys: `vargSrc: 'vp'` (source selector) and
   `vpUrl: ''`.
2. Restore the settings registry rows — the `Source` segmented control
   (`opts: [['vp','VargPilot'], ['ble','Direct BLE']]`, `apply: applyVarg`)
   and the `vpUrl` text row (`sec: 'vp'`, placeholder
   `http://127.0.0.1:8080`).
3. Restore the settings markup: the `VargPilot server` heading, its
   `data-reg="vp"` mount, and the `#vpRow` button row (Connect +
   `Probe API → console`).
4. Restore `vp`, `VP_P`, `vpMapPaths`, `vpUrlBase`, `vpClose`, `vpConnect`,
   `vpSniff`, `vpProp`, `vpApplyMode`, `vpProbe`.
5. Re-add the source branches: `vargUI` (row visibility + VP status
   strings), `applyVarg` (`vpConnect` vs `vargBoot`), the source cell and
   the Reconnect handler on the telemetry page, and the `vargSrc === 'ble'`
   guards in `vargDropped` / `vargRetry` / `vargEnsure` / the stale-stream
   watchdog.

Everything decoded from VP fed the same `vargApplyState({mode, special,
neutral, hp, regen, tc})` entry point that the BLE decoders use. Thus the
UI layer needs no changes — only the source plumbing.

## Related

- `docs/varg-ble.html` — the BLE protocol spec (rev 2) for the direct path.
- The mock VP server for the tests was a small dependency-free Node script
  with a raw WebSocket handshake, kept in a scratchpad. Rebuild it if
  needed.
