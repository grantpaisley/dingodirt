import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { packByToken } from "@/lib/packs";
import { outageJson, reportOutage } from "@/lib/alert";
import { clientIp, createRateLimiter } from "@/lib/ratelimit";

// Best-effort per-IP rate limit (per instance), alongside Turnstile.
const limiter = createRateLimiter(5, 60 * 60 * 1000);

async function verifyTurnstile(
  token: string | null,
  ip: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured (local dev)
  if (!token) return false;
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    },
  );
  if (!res.ok) return false;
  const data = (await res.json()) as { success: boolean };
  return data.success;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (limiter.hit(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many reports — try again later." },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token : "";
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  const turnstileToken =
    typeof body.turnstileToken === "string" ? body.turnstileToken : null;

  if (!reason) {
    return NextResponse.json(
      { ok: false, error: "Tell us what's wrong with the route." },
      { status: 400 },
    );
  }
  if (!(await verifyTurnstile(turnstileToken, ip))) {
    return NextResponse.json(
      { ok: false, error: "Captcha check failed — give it another go." },
      { status: 400 },
    );
  }

  let pack;
  try {
    pack = await packByToken(token);
  } catch (err) {
    await reportOutage("/api/report", err);
    return outageJson();
  }
  if (!pack) {
    return NextResponse.json(
      { ok: false, error: "Pack not found." },
      { status: 404 },
    );
  }

  try {
    await db
      .insert(reports)
      .values({ packId: pack.id, reason, reporterIp: ip });
  } catch (err) {
    console.error("report insert failed", err);
    return NextResponse.json(
      { ok: false, error: "Couldn't save the report — try again later." },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
