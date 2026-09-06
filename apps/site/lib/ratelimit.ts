// Best-effort per-IP rate limit, per server instance.
//
// Serverless gives us no shared state, so this bounds abuse per warm
// instance rather than globally — a trickle, not a wall. Good enough for
// endpoints where the cost of a call is small (a report row, a Routes API
// hit) and the honest use is a few calls an hour.

import type { NextRequest } from "next/server";

export type RateLimiter = {
  /** Count one hit for `key`; true when the caller is now over the cap. */
  hit(key: string, now?: number): boolean;
};

export function createRateLimiter(
  maxPerWindow: number,
  windowMs: number,
): RateLimiter {
  const hits = new Map<string, { count: number; reset: number }>();
  return {
    hit(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || now > entry.reset) {
        hits.set(key, { count: 1, reset: now + windowMs });
        return false;
      }
      return ++entry.count > maxPerWindow;
    },
  };
}

/** The caller's IP as the platform reports it (first hop of the proxy chain). */
export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  );
}
