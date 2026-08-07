import { NextRequest, NextResponse } from "next/server";
import { del, head } from "@vercel/blob";
import { requirePublisher } from "@/lib/publish-auth";
import {
  publishPack,
  PackValidationError,
  StorageUnavailableError,
} from "@/lib/packs";

export const runtime = "nodejs";

// Second half of the presigned upload flow (see ../upload/route.ts): the
// daemon has PUT the bundle to Blob storage; this validates it and turns it
// into a pack version, mirroring the multipart /api/packs response shape.

export async function POST(req: NextRequest) {
  const user = await requirePublisher(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const pathname = body?.pathname;
  const filename = body?.filename;
  if (typeof pathname !== "string" || typeof filename !== "string") {
    return NextResponse.json(
      { ok: false, error: "Missing pathname or filename." },
      { status: 400 },
    );
  }
  // Only the uploader's own landing zone can be completed.
  if (!pathname.startsWith(`uploads/${user.id}/`)) {
    return NextResponse.json(
      { ok: false, error: "That upload doesn't belong to you." },
      { status: 403 },
    );
  }

  const rawVisibility = body?.visibility;
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
  const packId = body?.packId;

  let buf: Buffer;
  try {
    const meta = await head(pathname);
    const res = await fetch(meta.downloadUrl ?? meta.url);
    if (!res.ok) throw new Error(`blob fetch ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("uploaded blob unreadable", err);
    return NextResponse.json(
      { ok: false, error: "Uploaded file not found — upload it again." },
      { status: 400 },
    );
  }

  try {
    const { pack, version, isNew } = await publishPack(user, buf, filename, {
      visibility,
      packId: typeof packId === "string" && packId ? packId : undefined,
      preUploadedPathname: pathname,
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
      // The landing-zone blob is useless now; don't leave it orphaned.
      await del(pathname).catch(() => {});
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
    console.error("publish (complete) failed", err);
    return NextResponse.json(
      { ok: false, error: "Publish failed — try again later." },
      { status: 500 },
    );
  }
}
