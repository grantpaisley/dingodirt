// Outage alerts. When a database read throws, the site now says so instead of
// pretending the pack is gone (see components/ServiceDown) — and this module
// tells the operator by email so nobody has to notice by accident.
//
// Delivery is Resend's REST API over plain fetch, so there is no extra
// dependency and no SDK to keep current. With RESEND_API_KEY unset (local
// dev, previews) the alert is logged and nothing is sent.

import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";

const THROTTLE_MS = 30 * 60_000;
const SEND_TIMEOUT_MS = 5_000;

/**
 * Last send, per server instance. Serverless gives us no shared state — and
 * the database, which would, is the thing that is down — so an outage costs
 * at most one mail per warm instance per window. That is a bounded trickle
 * rather than a mail storm, which is all this needs to be.
 */
let lastSentAt = 0;

function alertTo(): string {
  return process.env.ALERT_TO ?? "grant@angrykoala.com.au";
}

function alertFrom(): string {
  // Resend refuses unverified domains; onboarding@resend.dev is the fallback
  // sender, and it may only mail the Resend account's own address.
  return process.env.ALERT_FROM ?? "dingodirt alerts <onboarding@resend.dev>";
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Report a failed database read on `where` (a request path or page name).
 * Never throws and never rejects: an alert that breaks the error path is
 * worse than no alert.
 */
export async function reportOutage(where: string, err: unknown): Promise<void> {
  // redirect(), notFound() and the request-time APIs signal Next.js by
  // throwing. Every caller runs this at the top of a catch block, so this is
  // where those signals must be let back out — swallowing one would, for
  // example, render a static outage page in place of a real redirect.
  unstable_rethrow(err);

  const detail = describe(err);
  console.error(`[outage] ${where}: ${detail}`, err);

  const key = process.env.RESEND_API_KEY;
  if (!key) return;

  const now = Date.now();
  if (now - lastSentAt < THROTTLE_MS) return;
  lastSentAt = now;

  const deployment = process.env.VERCEL_URL ?? "local";
  const region = process.env.VERCEL_REGION ?? "unknown";
  const stamp = new Date(now).toISOString();

  const body = [
    `dingodirt could not reach its database.`,
    ``,
    `Where:      ${where}`,
    `Error:      ${detail}`,
    `When:       ${stamp}`,
    `Deployment: ${deployment}`,
    `Region:     ${region}`,
    ``,
    `Visitors are seeing "Service unavailable" on that path.`,
    `Check the Neon dashboard and the DATABASE_URL for this deployment.`,
    ``,
    `Health check: https://dingodirt.com/api/health`,
    ``,
    `Further alerts from this server instance are held for 30 minutes.`,
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: alertFrom(),
        to: [alertTo()],
        subject: `dingodirt: database unreachable (${where})`,
        text: body,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Let the next failure try again rather than sit out the window.
      lastSentAt = 0;
      console.error(
        `[outage] alert mail rejected (${res.status}): ${await res.text()}`,
      );
    }
  } catch (mailErr) {
    lastSentAt = 0;
    console.error("[outage] alert mail failed", mailErr);
  }
}

/**
 * The one answer every API route gives when the database is unreachable.
 * 503 (not 404) so callers and monitors can tell an outage from a dead link.
 */
export function outageJson(headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error:
        "dingodirt's database is unreachable — try again in a few minutes.",
    },
    { status: 503, headers: { "Cache-Control": "no-store", ...headers } },
  );
}
