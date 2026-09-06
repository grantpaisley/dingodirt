import { NextRequest, NextResponse } from "next/server";
import {
  GmapsError,
  buildRouteGpx,
  computeRoute,
  isGmapsHost,
  parseDirUrl,
  resolveUrl,
} from "@/lib/gmaps";
import { clientIp, createRateLimiter } from "@/lib/ratelimit";

export const runtime = "nodejs";

// A shared Google Maps directions link → a routed GPX, for DingoNav.
// Design: docs/plans/nav-2026-09-06-gmaps-link-import-design.md.
//
// Open to anyone, rate limited per IP: every successful call is a Routes
// API hit on the operator's key, so the cap keeps a bad day to a few
// dollars. The key itself is restricted to the Routes API in the Cloud
// console.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const limiter = createRateLimiter(10, 60 * 60 * 1000);

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status, headers: CORS });
}

// Nav posts JSON from nav.dingodirt.com, so the browser preflights.
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  if (limiter.hit(clientIp(req))) {
    return fail(429, "Too many route imports — try again in an hour.");
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url || !isGmapsHost(url)) {
    return fail(
      400,
      "Expected a Google Maps link (maps.app.goo.gl or google.com/maps/dir/…).",
    );
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return fail(
      422,
      "GOOGLE_MAPS_API_KEY is not set — create a Google Cloud API key with the Routes API enabled and add it to the site's environment.",
    );
  }

  try {
    const full = await resolveUrl(url);
    if (!isGmapsHost(full)) {
      return fail(400, "That link does not resolve to Google Maps.");
    }
    const dir = parseDirUrl(full);
    const points = await computeRoute(dir, apiKey);
    if (points.length < 2) {
      return fail(400, "Routes API returned an empty route.");
    }
    const gpx = buildRouteGpx(dir, url, points);
    return new NextResponse(gpx, {
      headers: {
        ...CORS,
        "Content-Type": "application/gpx+xml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof GmapsError) return fail(400, err.message);
    console.error("gmaps route failed", err);
    return fail(502, "Couldn't fetch the route from Google — try again.");
  }
}
