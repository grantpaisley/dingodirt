import { NextRequest, NextResponse } from "next/server";
import { issueSignedToken, presignUrl } from "@vercel/blob";
import { requirePublisher } from "@/lib/publish-auth";

export const runtime = "nodejs";

// Vercel caps serverless request bodies at 4.5 MB, so real packs (tens of
// MB of tiles) can't come through /api/packs directly. This route mints a
// presigned URL so the daemon PUTs the bundle straight to Blob storage,
// then confirms via /api/packs/complete.

const MAX_BYTES = 512 * 1024 * 1024;
const EXTENSIONS = [".dingonav", ".dingoscheme"];

export async function POST(req: NextRequest) {
  const user = await requirePublisher(req, { spend: true });
  if (user instanceof NextResponse) return user;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "Pack storage isn't configured on this deployment yet." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => null);
  const filename = body?.filename;
  const size = body?.size;
  if (
    typeof filename !== "string" ||
    !EXTENSIONS.some((e) => filename.toLowerCase().endsWith(e))
  ) {
    return NextResponse.json(
      { ok: false, error: "Upload a .dingonav or .dingoscheme file." },
      { status: 400 },
    );
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return NextResponse.json(
      { ok: false, error: "Missing upload size." },
      { status: 400 },
    );
  }
  if (size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "Pack is too large (512 MB limit)." },
      { status: 400 },
    );
  }

  // Landing zone scoped to the uploader; /complete refuses pathnames
  // outside the caller's own prefix.
  const base = filename.split("/").pop() ?? filename;
  const pathname = `uploads/${user.id}/${crypto.randomUUID()}/${base}`;
  const validUntil = Date.now() + 60 * 60 * 1000;

  try {
    const signed = await issueSignedToken({
      pathname,
      operations: ["put"],
      validUntil,
      maximumSizeInBytes: MAX_BYTES,
    });
    const { presignedUrl } = await presignUrl(signed, {
      access: "public",
      operation: "put",
      pathname,
      validUntil,
      maximumSizeInBytes: MAX_BYTES,
    });
    return NextResponse.json({ ok: true, uploadUrl: presignedUrl, pathname });
  } catch (err) {
    console.error("presign failed", err);
    return NextResponse.json(
      { ok: false, error: "Couldn't set up the upload — try again later." },
      { status: 503 },
    );
  }
}
