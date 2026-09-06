import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { reportOutage } from "@/lib/alert";

// Point an uptime monitor here. Unlike a page, this can answer with a real
// 503, so a monitor sees the outage even if nobody is browsing the site.
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json(
      { ok: true, db: "up", ms: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    await reportOutage("/api/health", err);
    return NextResponse.json(
      { ok: false, db: "down" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
