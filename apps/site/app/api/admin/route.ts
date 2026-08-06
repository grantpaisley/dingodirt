import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { allowlist, packs, reports } from "@/db/schema";
import { currentUser, isAdmin } from "@/lib/membership";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Single admin endpoint: GET = overview, POST = { action, ... }.
export async function GET() {
  const user = await currentUser();
  if (!isAdmin(user)) return NextResponse.json({ ok: false }, { status: 403 });
  const [pending, openReports, roles, allPacks] = await Promise.all([
    db
      .select()
      .from(packs)
      .where(and(eq(packs.visibility, "pending"), isNull(packs.deletedAt)))
      .orderBy(desc(packs.updatedAt)),
    db
      .select()
      .from(reports)
      .where(eq(reports.resolved, false))
      .orderBy(desc(reports.createdAt)),
    db.select().from(allowlist).orderBy(allowlist.email),
    db.select().from(packs).orderBy(desc(packs.updatedAt)).limit(200),
  ]);
  return NextResponse.json({
    ok: true,
    pending,
    reports: openReports,
    roles,
    packs: allPacks,
  });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!isAdmin(user)) return NextResponse.json({ ok: false }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const packId = typeof body.packId === "string" ? body.packId : "";

  // Public-listing review queue
  if (action === "approve-pack" && packId) {
    await db
      .update(packs)
      .set({ visibility: "public" })
      .where(and(eq(packs.id, packId), eq(packs.visibility, "pending")));
    return NextResponse.json({ ok: true });
  }
  if (action === "reject-pack" && packId) {
    await db
      .update(packs)
      .set({ visibility: "unlisted" })
      .where(and(eq(packs.id, packId), eq(packs.visibility, "pending")));
    return NextResponse.json({ ok: true });
  }

  // Trusted / admin roles
  if (action === "set-role") {
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json(
        { ok: false, error: "Bad email." },
        { status: 400 },
      );
    }
    const role = body.role === "admin" ? ("admin" as const) : ("trusted" as const);
    await db
      .insert(allowlist)
      .values({ email, role })
      .onConflictDoUpdate({ target: allowlist.email, set: { role } });
    return NextResponse.json({ ok: true });
  }
  if (action === "remove-role") {
    if (email === user.email) {
      return NextResponse.json(
        { ok: false, error: "You can't demote yourself." },
        { status: 400 },
      );
    }
    await db.delete(allowlist).where(eq(allowlist.email, email));
    return NextResponse.json({ ok: true });
  }

  // Moderation
  if (action === "hide-pack" && packId) {
    await db
      .update(packs)
      .set({ deletedAt: new Date() })
      .where(eq(packs.id, packId));
    return NextResponse.json({ ok: true });
  }
  if (action === "resolve-report" && typeof body.reportId === "string") {
    await db
      .update(reports)
      .set({ resolved: true })
      .where(eq(reports.id, body.reportId));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { ok: false, error: "Unknown action." },
    { status: 400 },
  );
}
