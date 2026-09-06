import { NextRequest, NextResponse } from "next/server";
import { currentUser, type SessionUser } from "@/lib/membership";
import { outageJson, reportOutage } from "@/lib/alert";
import { userForToken } from "@/lib/tokens";

// Best-effort per-user upload rate limit (per instance), shared by every
// publish entry point so the multipart and presigned paths draw on one
// hourly budget.
const hits = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

/**
 * Resolve the publisher — a `ddt_…` API token from Plan/Studio via Bearer,
 * or the site session cookie; both land on the same SessionUser shape.
 * Returns a ready-to-return error response when the caller isn't allowed.
 * `spend` burns one slot of the hourly upload budget (the presigned flow
 * spends on mint, not on complete, so one publish costs one slot).
 */
export async function requirePublisher(
  req: NextRequest,
  opts: { spend?: boolean } = {},
): Promise<SessionUser | NextResponse> {
  const bearer = req.headers.get("authorization");
  // The publisher's role decides whether a public pack skips the review
  // queue, so a role we could not read must stop the publish, not guess it.
  let user: SessionUser | null;
  try {
    user = bearer?.startsWith("Bearer ")
      ? await userForToken(bearer.slice(7)).catch(() => null)
      : await currentUser();
  } catch (err) {
    await reportOutage("publish", err);
    return outageJson();
  }
  if (!user) {
    return NextResponse.json(
      bearer
        ? { ok: false, error: "Invalid or revoked API token." }
        : { ok: false, error: "Sign in to publish." },
      { status: bearer ? 401 : 403 },
    );
  }

  if (opts.spend) {
    const now = Date.now();
    const entry = hits.get(user.id);
    if (!entry || now > entry.reset) {
      hits.set(user.id, { count: 1, reset: now + WINDOW_MS });
    } else if (++entry.count > MAX_PER_WINDOW) {
      return NextResponse.json(
        { ok: false, error: "Upload limit reached — try again in an hour." },
        { status: 429 },
      );
    }
  }

  return user;
}
