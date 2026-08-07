import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/membership";
import { userForToken } from "@/lib/tokens";
import {
  publishPack,
  PackValidationError,
  StorageUnavailableError,
} from "@/lib/packs";

export const runtime = "nodejs";

// Best-effort per-user upload rate limit (per instance).
const hits = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

export async function POST(req: NextRequest) {
  // Bearer (a ddt_… API token from Plan/Studio) or the session cookie —
  // both resolve to the same SessionUser shape.
  const bearer = req.headers.get("authorization");
  const user = bearer?.startsWith("Bearer ")
    ? await userForToken(bearer.slice(7)).catch(() => null)
    : await currentUser();
  if (!user) {
    return NextResponse.json(
      bearer
        ? { ok: false, error: "Invalid or revoked API token." }
        : { ok: false, error: "Sign in to publish." },
      { status: bearer ? 401 : 403 },
    );
  }

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

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { ok: false, error: "Attach a .dingonav or .dingoscheme file." },
      { status: 400 },
    );
  }

  const rawVisibility = form?.get("visibility");
  if (
    typeof rawVisibility === "string" &&
    rawVisibility !== "" &&
    !["private", "unlisted", "public"].includes(rawVisibility)
  ) {
    return NextResponse.json(
      { ok: false, error: "Bad visibility." },
      { status: 400 },
    );
  }
  const visibility =
    typeof rawVisibility === "string" && rawVisibility !== ""
      ? (rawVisibility as "private" | "unlisted" | "public")
      : undefined;
  const packId = form?.get("packId");

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const { pack, version, isNew } = await publishPack(user, buf, file.name, {
      visibility,
      packId: typeof packId === "string" && packId ? packId : undefined,
    });
    return NextResponse.json({
      ok: true,
      isNew,
      version,
      pack: {
        id: pack.id,
        name: pack.name,
        type: pack.type,
        shareToken: pack.shareToken,
        visibility: pack.visibility,
      },
    });
  } catch (err) {
    if (err instanceof PackValidationError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: 400 },
      );
    }
    if (err instanceof StorageUnavailableError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: 503 },
      );
    }
    console.error("publish failed", err);
    return NextResponse.json(
      { ok: false, error: "Publish failed — try again later." },
      { status: 500 },
    );
  }
}
