import { NextRequest, NextResponse } from "next/server";
import { requirePublisher } from "@/lib/publish-auth";
import {
  publishPack,
  PackValidationError,
  StorageUnavailableError,
} from "@/lib/packs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await requirePublisher(req, { spend: true });
  if (user instanceof NextResponse) return user;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { ok: false, error: "Attach a .dingonav, .dingoscheme or .dingoplan file." },
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
