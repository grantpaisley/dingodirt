# Car screens, and "open this GPX with DingoNav"

**Status (2026-10-12):** the GPX half is **built**; the car half is
**parked**. Three questions were asked together, and the answers split
cleanly into what ships today and what needs a native app first.

1. Can DingoNav run on CarPlay / Android Auto?
2. Can it appear as an option when you open a GPX file?
3. Can it stay just a link — and what would being an app actually buy?

## 1. Car screens: not without a native app, and not by wrapping this one

**Neither CarPlay nor Android Auto can render web content.** The car
display draws only native, templated UI supplied by an installed native
app. There is no web view, no canvas, no escape hatch. So there is no
amount of manifest or service-worker work that puts DingoNav on a car
screen.

- **CarPlay** gates you before you can even compile. You apply to Apple
  for a CarPlay entitlement, and until it is granted the frameworks will
  not build. The entitlement locks you to one category; the navigation
  category is reviewed for driver distraction, and the templates are
  limited to a depth of 5.
- **Android Auto** needs the Android for Cars App Library and its
  navigation templates. Public distribution needs Google's approval of
  the app for the navigation category — which currently also means
  supporting Gemini and Assistant voice commands, light and dark theming
  for Car App Library 1.9+, and letting a reviewer drive it with a mock
  GPS location if the app is not available in the US. Sideloading via
  Android Auto's developer settings ("Unknown sources") works today for
  personal use, and is the only route that skips all of the above, but
  recent Android Auto releases have been dropping sideloaded apps from
  the launcher.

**The consequence worth writing down:** a car version is not a port. The
things that make DingoNav itself — MapLibre, the offline `.pmtiles`
basemap, the hillshade, the cue rendering, the glove layout, Studio's
schemes and behaviors — none of it crosses over. You would be building a
**second navigation UI** that draws into a template-supplied surface and
shares only the track data with the web app. That is a product, not a
feature.

**Decision: not now.** Revisit when a car screen is the thing actually
blocking a ride.

## 2. Opening a GPX: Android gets Share, desktop gets Open with

Two different web platform features, and only one of them works on a
phone:

| | `file_handlers` | `share_target` |
|---|---|---|
| Desktop Chromium | yes — "Open with" | n/a |
| Android (installed PWA) | **no** | **yes** — the share sheet |
| iOS | no | no |

`file_handlers` — which this manifest already used for `.dingonav` — is
**Chromium desktop only**. It does nothing on Android. So "Open with →
DingoNav" is not available to a web app on a phone, and the honest
Android answer is **Share → DingoNav**, which needs no native code at
all.

### What shipped

- **`manifest.json`** — `.gpx` and `.geojson` added to `file_handlers`
  (desktop "Open with"), and the `share_target` converted from GET to
  POST / `multipart/form-data` so it can carry files.
- **`sw.js`** — answers the share POST itself.
- **`index.html`** — drains the handed-over files into the existing
  `handleFiles()`, the same path as the file picker, drag-drop and the
  `launchQueue` file handler.

### Two constraints that shaped it

**Nav is on GitHub Pages, so nothing can receive a POST.** A share_target
that carries files *must* be POST/multipart — a GET target can only carry
title, text and url. With no server, the service worker answers the POST
itself: it parks the files in a separate `dingonav-share` cache and
redirects to `./?share_files=1`, which the page drains on boot. Three
things follow, and all three are guarded by
`tests/nav-share-target.test.mjs`:

- the POST branch must sit **above** the `method !== 'GET'` bail-out in
  the `fetch` handler, or the POST reaches the static host and 405s;
- the `activate` sweep must spare the share cache, or an app update
  mid-share deletes the files;
- the shell lookups are now pinned with `cacheName: CACHE`, so a parked
  share can never be served as app shell.

**A manifest gets exactly one `share_target`.** The existing one was a
GET target feeding the Google Maps link import (`?share=` / `?url=`,
added 2026-09-06). Converting it to POST had to keep that working, so the
worker rebuilds the old query string for a text or link share and only
uses the file path when files are actually present. Both shapes are
covered by the behaviour tests.

A note on the accept list: it includes `application/octet-stream`,
because Android matches the share sheet on MIME type and plenty of apps
hand a `.gpx` over as an untyped blob. The cost is that DingoNav offers
itself for other untyped files too. That is the right side to err on — a
GPX that does *not* offer DingoNav is the failure that matters, and the
file picker has always accepted `application/octet-stream` for the same
reason.

### If a true Android "Open with" is ever wanted

It needs an APK. The cheap route is a Trusted Web Activity around the
existing PWA (Bubblewrap), with an `intent-filter` for `.gpx` hand-added
to the generated `AndroidManifest.xml` — Bubblewrap generates the
host-URL filter but not file associations. That is a build pipeline and
signing keys for one line of UI nicety, which is why it was not done
here. On iOS it needs `CFBundleDocumentTypes` in a real app; a PWA cannot
register document types at all.

## 3. What a native wrapper would actually buy

The question was whether staying a link costs anything real. It does —
four things, all of which are already written down elsewhere in this
repo, which is the sign they are real rather than theoretical.

- **Storage that is not evicted.** iOS evicts PWA storage after a period
  of disuse: the offline basemap and the loaded packs can simply vanish
  before a ride. Already flagged as the first pro in
  `nav-2026-08-07-monetisation-options.md` ("the only route to robust
  offline storage").
- **Background GPS recording.** Web geolocation stops when the screen
  sleeps or the rider switches apps, so a web ride log has holes in it. A
  foreground service records the whole ride.
- **Orientation lock and screen control.**
  `nav-future-developments.md` parked the landscape-lock button precisely
  because iOS blocks `screen.orientation.lock` outright and Android only
  honours it for an installed PWA in fullscreen. That entry ends
  "Revisit this only if the app is wrapped natively" — this is that
  revisit, and the answer is still "only as part of a wrapper".
- **The Stark Varg link, which is the strongest of the four.** Today the
  rider must bond the bike in Android Settings first, because Chrome
  cannot create an encrypted BLE bond itself, and must leave the Stark
  app or VargPilot running because the VCU only streams once one of them
  has started the telemetry. Native BLE removes the browser-imposed half
  of that: `createBond()` in-app, a foreground service holding the GATT
  link across app switches, no re-selection through the chooser, no
  Chrome Web Bluetooth blocklist — and the one thing Web Bluetooth can
  never do, **iOS at all**.
  `nav-2026-07-28-vargpilot-webserver-source.md` calls iOS "the single
  strongest reason" to restore the VargPilot WebSocket source; a native
  app is the other way to get there.

  **Do not overstate this one.** Whether DingoNav could start the
  telemetry stream *unaided* — without the Stark app or VargPilot having
  started it — is an unresolved **protocol** question, not a browser
  limitation. It lives behind the unmapped characteristics that the
  "Probe extra channels" button exists to find. Going native makes it
  possible to investigate without Chrome in the way; it does not make it
  work.

### The case against, unchanged

An app install is exactly the friction to avoid at a dusty staging area
with one bar of reception; store review slows iteration; and Apple and
Google take 15–30% of anything sold through it. The monetisation doc's
verdict stands: a wrapper is a *later* move, started by features, not by
payments.

## Verification

Covered by `tests/nav-share-target.test.mjs` (static guards plus
behaviour tests that load `sw.js` into a mock worker scope and assert
what the handler actually returns). Confirmed end to end in Chromium
against `node apps/nav/serve.js`: a multipart POST navigation to
`./share-target` carrying a `.gpx` redirects to `?share_files=1`, the
track imports with its geometry and persists to IndexedDB, the URL is
stripped back to `./`, the share cache is left empty, and a reload does
not re-import.
