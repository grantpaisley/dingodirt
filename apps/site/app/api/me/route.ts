import { NextRequest, NextResponse } from "next/server";
import { isTrusted } from "@/lib/membership";
import { userForToken } from "@/lib/tokens";

export const runtime = "nodejs";

// "Who am I" for Bearer callers — the daemon hits this to show
// "Connected as Grant" in Plan's settings and to validate a pasted token.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const user = auth.startsWith("Bearer ")
    ? await userForToken(auth.slice(7)).catch(() => null)
    : null;
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Invalid or revoked API token." },
      { status: 401 },
    );
  }
  return NextResponse.json({
    ok: true,
    name: user.name,
    email: user.email,
    trusted: isTrusted(user),
  });
}
