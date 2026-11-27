// Operator alerts. When a database read throws, the site now says so instead
// of pretending the pack is gone (see components/ServiceDown) — and this
// module tells the operator by email so nobody has to notice by accident.
// The same goes for a pack whose stored file Blob storage will not serve.
//
// Delivery is Resend's REST API over plain fetch, so there is no extra
// dependency and no SDK to keep current. With RESEND_API_KEY unset (local
// dev, previews) the alert is logged and nothing is sent.

import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";

const THROTTLE_MS = 30 * 60_000;
const SEND_TIMEOUT_MS = 5_000;

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
 * Last send per alert kind, per server instance. Serverless gives us no
 * shared state — and the database, which would, may be the thing that is
 * down — so a fault costs at most one mail per kind per warm instance per
 * window. That is a bounded trickle rather than a mail storm. Kinds throttle
 * separately so a database outage cannot hide a storage fault, or the reverse.
 */
const lastSentAt = new Map<string, number>();

/** Mail the operator. Never throws; throttled per `kind`. */
async function sendAlert(
  kind: string,
  subject: string,
  lines: string[],
): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;

  const now = Date.now();
  if (now - (lastSentAt.get(kind) ?? 0) < THROTTLE_MS) return;
  lastSentAt.set(kind, now);

  const body = [
    ...lines,
    `When:       ${new Date(now).toISOString()}`,
    `Deployment: ${process.env.VERCEL_URL ?? "local"}`,
    `Region:     ${process.env.VERCEL_REGION ?? "unknown"}`,
    ``,
    `Further alerts of this kind from this server instance are held for 30 minutes.`,
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
        subject,
        text: body,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Let the next failure try again rather than sit out the window.
      lastSentAt.delete(kind);
      console.error(
        `[alert] mail rejected (${res.status}): ${await res.text()}`,
      );
    }
  } catch (mailErr) {
    lastSentAt.delete(kind);
    console.error("[alert] mail failed", mailErr);
  }
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

  await sendAlert("outage", `dingodirt: database unreachable (${where})`, [
    `dingodirt could not reach its database.`,
    ``,
    `Where:      ${where}`,
    `Error:      ${detail}`,
    ``,
    `Visitors are seeing "Service unavailable" on that path.`,
    `Check the Neon dashboard and the DATABASE_URL for this deployment.`,
    ``,
    `Health check: https://dingodirt.com/api/health`,
    ``,
  ]);
}

/** What went wrong reading a stored pack file from Blob storage. */
export interface StorageFault {
  packId: string;
  version: number;
  blobUrl: string;
  /** Blob's HTTP status, or null when the fetch itself threw. */
  status: number | null;
  /** Blob's response body (trimmed), or the thrown error. */
  detail: string;
}

/**
 * Report a pack file that Blob storage would not serve. The database row
 * exists but its blob does not answer, so every download of that pack fails
 * until it is republished or the store is fixed. Never throws.
 */
export async function reportStorageFault(
  where: string,
  fault: StorageFault,
): Promise<void> {
  const status = fault.status === null ? "fetch threw" : `HTTP ${fault.status}`;
  console.error(
    `[storage] ${where}: pack ${fault.packId} v${fault.version} blob ${status} ` +
      `${fault.blobUrl} — ${fault.detail}`,
  );

  await sendAlert("storage", `dingodirt: pack file unreadable (${where})`, [
    `dingodirt could not read a pack file from Blob storage.`,
    ``,
    `Where:      ${where}`,
    `Pack:       ${fault.packId} v${fault.version}`,
    `Blob URL:   ${fault.blobUrl}`,
    `Blob reply: ${status}`,
    `Detail:     ${fault.detail}`,
    ``,
    `Every download of this pack fails until the blob is readable again.`,
    `404: the file is gone — republish the pack. 403: check the Blob store's`,
    `access mode and usage limits in the Vercel dashboard.`,
    ``,
  ]);
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
