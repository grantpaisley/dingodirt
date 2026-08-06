# Dingo · Strava Heatmap Connector (Chrome extension)

One click to send Strava's global-heatmap **CloudFront cookies** to your local
Dingo daemon, which then proxies the authenticated heatmap tiles into the Dingo
web UI (and, later, export bundles).

## Why an extension?

The three signing cookies (`CloudFront-Key-Pair-Id`, `CloudFront-Policy`,
`CloudFront-Signature`) are **httpOnly** — invisible to page scripts, bookmarklets,
and hard to copy by hand (they're scoped to the `heatmap-external-*.strava.com`
tile host, not `www.strava.com`). A browser extension with the `cookies`
permission is the one thing that can read them cleanly.

## Install (once)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder
   (`tools/strava-connector-extension`).
4. The Dingo icon appears in the toolbar. (Pin it via the puzzle-piece menu.)

## Use (weekly, ~1 click)

1. Make sure the Dingo daemon (`dingo-server`) is running on `localhost:3000`.
2. Be logged into **strava.com** and open
   `strava.com/maps/global-heatmap` once so the CloudFront cookies are fresh.
3. Click the extension icon → it reads the cookies and posts them to the daemon,
   showing ✅ on success.
4. In Dingo, toggle **Layers → Strava heatmap**. Done.

The signed cookies expire after roughly a week; when the overlay goes blank,
reload the heatmap page and click the extension again.

## Notes

- Talks only to `*.strava.com` (to read cookies) and `http://localhost:3000`
  (your daemon). Nothing leaves your machine.
- Daemon URL is editable in the popup if you run it on a different host/port.
- No custom icon shipped — Chrome shows a default puzzle piece; that's fine for
  a personal unpacked extension.
