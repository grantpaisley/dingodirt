import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/membership";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "@/lib/tokens";

export const runtime = "nodejs";

// Dashboard-only CRUD for API tokens. Session cookie auth on purpose — a
// token must never be able to mint or revoke tokens.

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in." }, { status: 403 });
  }
  const tokens = await listApiTokens(user.id);
  return NextResponse.json({ ok: true, tokens });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in." }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) {
    return NextResponse.json(
      { ok: false, error: "Give the token a name (e.g. the machine it's for)." },
      { status: 400 },
    );
  }
  const existing = await listApiTokens(user.id);
  if (existing.length >= 10) {
    return NextResponse.json(
      { ok: false, error: "Token limit reached — revoke one first." },
      { status: 400 },
    );
  }
  const { secret, row } = await createApiToken(user.id, name);
  return NextResponse.json({
    ok: true,
    secret,
    token: { id: row.id, name: row.name, createdAt: row.createdAt },
  });
}

export async function DELETE(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in." }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Missing token id." },
      { status: 400 },
    );
  }
  const gone = await revokeApiToken(user.id, id);
  if (!gone) {
    return NextResponse.json(
      { ok: false, error: "No such token." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
