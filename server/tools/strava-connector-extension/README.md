# Dingo · Strava Heatmap Connector (Chrome extension)

One click sends Strava's global-heatmap **CloudFront cookies** to your
local Dingo daemon. The daemon then proxies the authenticated heatmap tiles
into the Dingo web UI (and, later, into export bundles).

## Why an extension?

The three signing cookies (`CloudFront-Key-Pair-Id`, `CloudFront-Policy`,
`CloudFront-Signature`) are **httpOnly**. Page scripts and bookmarklets
cannot see them, and they are hard to copy by hand. They are scoped to the
`heatmap-external-*.strava.com` tile host, not to `www.strava.com`. A
browser extension with the `cookies` permission is the one thing that can
read them cleanly.

## Install (once)

1. Open `chrome://extensions` in Chrome.
2. Set **Developer mode** to on (top-right).
3. Click **Load unpacked** and select this folder
   (`tools/strava-connector-extension`).
4. The Dingo icon appears in the toolbar. (Pin it via the puzzle-piece
   menu.)

## Use (weekly, ~1 click)

1. Make sure that the Dingo daemon (`dingo-server`) runs on
   `localhost:3000`.
2. Log in to **strava.com**, and open `strava.com/maps/global-heatmap` one
   time, so the CloudFront cookies are fresh.
3. Click the extension icon. It reads the cookies and posts them to the
   daemon. It shows ✅ on success.
4. In Dingo, set **Layers → Strava heatmap** to on. Done.

The signed cookies expire after about one week. When the overlay becomes
blank, load the heatmap page again and click the extension again.

## Notes

- The extension talks only to `*.strava.com` (to read the cookies) and to
  `http://localhost:3000` (your daemon). Nothing leaves your machine.
- You can change the daemon URL in the popup if you run the daemon on a
  different host or port.
- No custom icon ships with the extension. Chrome shows a default puzzle
  piece. That is fine for a personal unpacked extension.
