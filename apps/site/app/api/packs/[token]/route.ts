import { NextRequest, NextResponse } from "next/server";
import { packByToken, currentVersionOf } from "@/lib/packs";
import { outageJson, reportOutage } from "@/lib/alert";

// Capability endpoint: metadata for pack pages and the apps.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let pack;
  try {
    pack = await packByToken(token);
  } catch (err) {
    await reportOutage(`/api/packs/${token}`, err);
    return outageJson({ "Access-Control-Allow-Origin": "*" });
  }
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
