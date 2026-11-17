# Off-grid pack comms — Reticulum, LoRa, and the cheaper things first

*2026-11-17. A feasibility review, not a scheduled feature. Grant asked whether
[Reticulum](https://reticulum.network/) could connect Nav to other riders' phones.
The short answer is that Reticulum solves the half of the problem we do not have,
and cannot run where Nav lives — but the question is the right one, and there are
two cheaper options underneath it. Nothing here is committed. Code references are
into `f8260c9`.*

## Problem

Nav's group-ride features need cell signal, and the rides do not have it. The
settings panel is honest about it — "Group ride (needs signal)" and "silently off
without signal" (`apps/nav/index.html:1049-1052`). Two things break out of
coverage:

- **Friends.** No position beacons, so no pack awareness at the exact moment it
  matters (someone off the back, someone down, a junction nobody agreed on).
- **Marks.** A rider tags a washout at the bottom of a valley. The record sits in
  the outbox until they come back into coverage. If the ride ends and the app is
  not reopened inside ntfy's ~12 h cache window, the harvest never sees it and the
  edit never reaches a bundle (see `dingo-2026-07-18-marks-sync-design.md`).

## What we have today

One transport, cleanly isolated in ~50 lines at
`apps/nav/index.html:5318-5369` — `wss://ntfy.sh/<topic>/ws` to listen,
`POST https://ntfy.sh/<topic>` to publish, topic = `dingonav-` + the sanitised
ride code, seen-id dedupe on receipt, whole-outbox re-announce on every
(re)connect (`publishTurnEdits` on `friendWS.onopen`). Two record shapes move
across it:

| Record | Shape | Size | Rate |
|---|---|---|---|
| Position beacon | `{n, la, lo}` | ~45–60 B | per rider, 20 s, nav-active only |
| Mark edit | `{id, op, kind, dir, la, lo, t, by}` | ~130–160 B | bursty, a handful per ride |

That isolation is the good news for any of this: swapping the medium is a small,
contained change. Finding a medium is the whole problem.

## What Reticulum is

A cryptography-based networking stack — self-configuring multi-hop transport,
end-to-end encryption, initiator anonymity — that runs over any medium offering
at least a half-duplex ~500 bps channel. The Python reference implementation is
`rns`; [LXMF](https://pypi.org/project/sbapp) is the store-and-forward messaging
layer on top, and Sideband is its Android/Linux/macOS client. It is genuinely
well-built and the right shape for what we want.

It is also, for our purposes, blocked three times over.

### 1. It cannot run inside a browser

There is a JS implementation ([reticulum-js](https://reticulum.js.org/)) and a
Go→WASM build, and both hit the same wall: a browser cannot open raw UDP
multicast or a serial port. The WASM build's own documentation says it
[tunnels frames over a WebSocket to a gateway](https://reticulum-go.quad4.io/docs/embedding-and-wasm)
that owns the real interfaces. A gateway is a host running a daemon on a
reachable network — precisely the thing that does not exist in the bush. Nav
would have to stop being a single-file PWA that Jules opens from a link, which
is the one property we have refused to trade away.

### 2. Reticulum is not a radio

It is routing and crypto over a medium you supply. With no extra hardware, the
only medium two phones share is an IP link — one rider hotspots, everyone joins,
and native RNS clients discover each other over AutoInterface with no internet
involved. That works, and it is ~50 m line-of-sight on a good day. Useless
across a spread-out pack. Real range means LoRa, which means an **RNode** (a
~$30–60 Heltec LoRa32-class board) per rider,
[paired to the phone over Bluetooth](https://circuitdigest.com/news/off-grid-connectivity-internet-independent-communication-with-reticulum-and-rnode).

### 3. iOS

Web Bluetooth and Web Serial do not exist in Safari on any platform, so even the
hardware route is Android-Chrome-only from a web app. Native iOS Reticulum is
still ragged: a long-running [TestFlight Sideband beta](https://github.com/markqvist/Reticulum/discussions/307),
a third-party App Store client, and
[community Swift ports](https://github.com/junomaluca/ReticulumMessenger) whose
own READMEs disagree about whether a native iOS client exists at all. Apple's
background-networking limits bite any client that wants to relay from a pocket.

## Why the data model already fits

Worth recording, because it is the part that would survive a transport change
untouched. The marks-sync design is already mesh-shaped:

- `id` is a content hash of op+coords+time, and every hop is idempotent against
  a seen-id set — the same property a flooding mesh needs.
- The outbox re-announce is store-and-forward by another name. Any rider who
  opens the app replays the group history.
- Reject-never-bakes means no retraction protocol, so eventual consistency is
  already the accepted semantics.

That is LXMF's model, reinvented over ntfy. If we ever did move to a mesh,
nothing above the transport would change.

## Capacity — not the blocker we assumed

Doing the arithmetic properly, because the first estimate in conversation was
wrong by ~8×:

- 6 riders × ~60 B per 20 s = 18 B/s = **~144 bps** of application payload.
  Against Reticulum's ~500 bps floor and LoRa's order-of-1 kbps at long-range
  settings, the bitrate has headroom.
- **Airtime is the real constraint.** At long-range LoRa settings a small packet
  costs a few hundred milliseconds of channel time. 0.3 packets/s × ~0.35 s is
  roughly 10% channel occupancy — fine. But a flooding mesh rebroadcasts, so
  multiply by the hop count: a spread-out 6-rider pack could plausibly reach
  30–50%, and that is where beacons start eating the marks.
- Mitigation is boring and known: stretch beacons to 60–120 s when off-grid,
  prioritise mark edits over positions, drop position history entirely.

So capacity rules out a live moving map of the whole pack, and does not rule out
"where is everyone, roughly" plus reliable mark propagation. The numbers above
are desk estimates and want bench measurement before anyone believes them.

## Options, ranked by cost

**A. QR sneakernet — cheapest, works everywhere, no hardware.**
At a regroup, rider A shows a QR of their unsent outbox; rider B scans it with
the camera. A QR code holds ~2–3 KB, which is ~15–20 mark edits — more than a
ride produces. Fully offline, works on iOS, no permissions beyond the camera, no
new protocol. It fixes the mark-propagation failure (the one with lasting
consequences) and does nothing for live positions. Days of work, not weeks.

**B. Hotspot + browser-to-browser — unknown, prototype before planning.**
One rider hotspots with no internet; phones exchange outboxes over the LAN. In a
browser that means WebRTC, which needs signalling — manual SDP via QR, at which
point option A is doing most of the work already — and local ICE depends on mDNS
candidate behaviour plus iOS's local-network permission prompt. Plausible, not
established. Any estimate before a spike is guesswork; the earlier "a few hours"
remark in conversation was too optimistic.

**C. Meshtastic — the pragmatic hardware route.**
Less elegantly engineered than Reticulum, but position beaconing is built in,
first-party phone apps exist on both platforms, and the BLE service is
documented well enough that community libraries implement the full protocol. The
integration becomes "read positions from a paired device" rather than "implement
a network stack". Same hardware cost as an RNode, far less to build. Caveat:
every Meshtastic specific in this doc came from secondary sources and needs
checking against the official docs and firmware notes before it is planned.

**D. Reticulum — correct, and a different product.**
A native companion app plus a radio per rider. The right answer if off-grid
comms ever becomes the product rather than a Nav feature; the wrong answer for
adding pack awareness to a PWA.

## Decision

**Parked, not scheduled.** Reticulum does not fit Nav as it stands, and the
honest version of "use Reticulum" is "build a native app and buy everyone a
radio" — out of scope for a single-file PWA.

If off-grid pack comms gets picked up, the order is **A**, then a spike on **B**,
then **C** only if riders actually want hardware. Reticulum stays on the list as
the thing to revisit if Nav is ever wrapped natively, because its data model is
the one we already have.

## Verify before picking any of this up

The deskwork below was done from search results; `reticulum.network` itself was
unreachable from the session that wrote this doc.

- Reticulum's current iOS story, from the project's own releases rather than
  community threads.
- Meshtastic's official BLE API surface and whether position sharing is reachable
  from a third-party client without their app.
- LoRa airtime and duty cycle on AU915 at the settings we would actually use,
  measured on a bench with two devices, not calculated.
- Whether `ntfy.sh`'s ~12 h cache window is the real constraint on mark loss, or
  whether riders simply never reopen the app — if it is the latter, option A is
  the whole fix and the rest is moot.
