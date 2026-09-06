import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { packs } from "@/db/schema";
import { isTrusted, isAdmin } from "@/lib/membership";
import { requestUserOr503 } from "@/lib/tokens";
import { resolveVisibilityRequest } from "@/lib/packs";

const REQUESTABLE = new Set(["private", "unlisted", "public"]);

async function ownedPack(id: string, userId: string, admin: boolean) {
  const [pack] = await db
    .select()
    .from(packs)
    .where(and(eq(packs.id, id), isNull(packs.deletedAt)));
  if (!pack) return null;
  if (!admin && pack.ownerId !== userId) return null;
  return pack;
}

// Owner (or admin) edits: visibility, description, folder.
// Requesting "public" from a plain user lands in "pending" until an admin
// approves it into the galleries; trusted/admin go straight to public.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requestUserOr503(req, "PATCH /api/packs/id");
  if (user instanceof NextResponse) return user;
  if (!user) return NextResponse.json({ ok: false }, { status: 403 });
  const { id } = await params;
  const pack = await ownedPack(id, user.id, isAdmin(user));
  if (!pack) {
    return NextResponse.json(
      { ok: false, error: "Not your pack." },
      { status: 404 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const updates: Partial<typeof packs.$inferInsert> = {};
  if (typeof body.visibility === "string") {
    if (!REQUESTABLE.has(body.visibility)) {
      return NextResponse.json(
        { ok: false, error: "Bad visibility." },
        { status: 400 },
      );
    }
    updates.visibility = resolveVisibilityRequest(
      body.visibility as "private" | "unlisted" | "public",
      isTrusted(user),
    );
  }
  if (typeof body.description === "string") {
    updates.description = body.description.slice(0, 2000);
  }
  if (body.folderId === null || typeof body.folderId === "string") {
    updates.folderId = (body.folderId as string | null) ?? null;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { ok: false, error: "Nothing to update." },
      { status: 400 },
    );
  }
  updates.updatedAt = new Date();
  await db.update(packs).set(updates).where(eq(packs.id, pack.id));
  return NextResponse.json({
    ok: true,
    visibility: updates.visibility ?? pack.visibility,
  });
}

// Retract = soft delete (blobs kept 30 days; a cleanup job purges later).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requestUserOr503(_req, "DELETE /api/packs/id");
  if (user instanceof NextResponse) return user;
  if (!user) return NextResponse.json({ ok: false }, { status: 403 });
  const { id } = await params;
  const pack = await ownedPack(id, user.id, isAdmin(user));
  if (!pack) {
    return NextResponse.json(
      { ok: false, error: "Not your pack." },
      { status: 404 },
    );
  }
  await db
    .update(packs)
    .set({ deletedAt: new Date() })
    .where(eq(packs.id, pack.id));
  return NextResponse.json({ ok: true });
}
