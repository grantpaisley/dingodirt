import { NextRequest, NextResponse } from "next/server";
import { packByToken, currentVersionOf } from "@/lib/packs";

// Capability endpoint: metadata for pack pages and the apps.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const pack = await packByToken(token).catch(() => null);
  if (!pack || pack.visibility === "private") {
    return NextResponse.json(
      { ok: false, error: "This pack is no longer shared." },
      { status: 404 },
    );
  }
  const version = await currentVersionOf(pack.id, pack.currentVersion);
  return NextResponse.json(
    {
      ok: true,
      pack: {
        name: pack.name,
        type: pack.type,
        author: pack.authorName,
        version: pack.currentVersion,
        updatedAt: pack.updatedAt,
        size: version?.size ?? null,
        previewUrl: version?.previewUrl ?? null,
        metadata: version?.metadata ? JSON.parse(version.metadata) : null,
        downloadUrl: `/api/packs/${pack.shareToken}/download`,
      },
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
