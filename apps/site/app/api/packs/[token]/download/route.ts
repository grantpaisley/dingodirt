import { NextRequest, NextResponse } from "next/server";
import { packByToken, currentVersionOf, countDownload } from "@/lib/packs";
import { outageJson, reportOutage } from "@/lib/alert";

export const runtime = "nodejs";

// Streams the pack zip. Blob URLs are never handed out raw, so flipping a
// pack back to private kills the link immediately. Every hit counts a
// download for the owner's stats.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let pack;
  try {
    pack = await packByToken(token);
  } catch (err) {
    await reportOutage(`/api/packs/${token}/download`, err);
    return outageJson({ "Access-Control-Allow-Origin": "*" });
  }
  if (!pack || pack.visibility === "private") {
    return NextResponse.json(
      { ok: false, error: "This pack is no longer shared." },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  const version = await currentVersionOf(pack.id, pack.currentVersion);
  if (!version) {
    return NextResponse.json(
      { ok: false, error: "Pack data missing." },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  const upstream = await fetch(version.blobUrl);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { ok: false, error: "Download failed — try again." },
      { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  await countDownload(pack.id).catch(() => {});

  const ext =
    pack.type === "ride"
      ? "dingonav"
      : pack.type === "plan"
        ? "dingoplan"
        : "dingoscheme";
  const filename = `${pack.slug}.${ext}`;
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type":
        pack.type === "plan" ? "application/json" : "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...(version.size ? { "Content-Length": String(version.size) } : {}),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
