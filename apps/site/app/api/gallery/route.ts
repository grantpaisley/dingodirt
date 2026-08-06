import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { packs } from "@/db/schema";

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  if (type !== "ride" && type !== "scheme") {
    return NextResponse.json(
      { ok: false, error: "type must be ride or scheme" },
      { status: 400 },
    );
  }
  try {
    const rows = await db
      .select({
        name: packs.name,
        slug: packs.slug,
        author: packs.authorName,
        updatedAt: packs.updatedAt,
        shareToken: packs.shareToken,
      })
      .from(packs)
      .where(
        and(
          eq(packs.type, type),
          eq(packs.visibility, "public"),
          isNull(packs.deletedAt),
        ),
      )
      .orderBy(desc(packs.updatedAt))
      .limit(100);
    return NextResponse.json({ ok: true, packs: rows });
  } catch {
    return NextResponse.json({ ok: true, packs: [] });
  }
}
