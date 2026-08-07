import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { packFeedback } from "@/db/schema";
import { packByToken, currentVersionOf } from "@/lib/packs";
import { currentUser } from "@/lib/membership";

export const runtime = "nodejs";

// Votes and comments on a planning pack's tracks/marks
// (docs/plans/2026-08-07-planning-mode-design.md). No sign-in: the share
// token is the gate and the voter is a self-reported name — mates-group
// trust. The server still validates shape, rate-limits by IP, and checks
// the voted item actually exists in the published plan.

// The site has no migration runner (schema changes are pushed by hand), so
// this route lazily ensures its own table — idempotent DDL, once per
// instance. Fold into a real migration if the site ever grows one.
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pack_feedback (
        id text PRIMARY KEY,
        pack_id text NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
        item_type text NOT NULL,
        item_id text NOT NULL,
        voter_name text NOT NULL,
        kind text NOT NULL,
        value text NOT NULL,
        updated_at timestamp NOT NULL DEFAULT now()
      )`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS pack_feedback_vote_unique
      ON pack_feedback (pack_id, item_type, item_id, voter_name)
      WHERE kind = 'vote'`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS pack_feedback_pack_idx
      ON pack_feedback (pack_id)`);
  })().catch((e) => {
    schemaReady = null; // retry on next request
    throw e;
  });
  return schemaReady;
}

const VOTES = ["yes", "maybe", "no"] as const;
const MAX_NAME = 24;
const MAX_COMMENT = 200;

// Per-IP rate limit (per instance): a voting session is bursty but small.
const hits = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 240;

function limited(req: NextRequest): boolean {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  return ++entry.count > MAX_PER_WINDOW;
}

/** The plan pack behind a token, if the caller may see it. */
async function visiblePlan(token: string) {
  const pack = await packByToken(token).catch(() => null);
  if (!pack || pack.type !== "plan") return null;
  if (pack.visibility === "private") {
    const user = await currentUser();
    if (!user || user.id !== pack.ownerId) return null;
  }
  return pack;
}

/** Item ids present in the published plan doc, cached per pack version so a
 *  vote doesn't re-download the blob every time. */
const itemCache = new Map<string, Set<string>>();
async function planItems(
  packId: string,
  version: number,
): Promise<Set<string> | null> {
  const key = `${packId}:${version}`;
  const cached = itemCache.get(key);
  if (cached) return cached;
  const v = await currentVersionOf(packId, version);
  if (!v?.blobUrl) return null;
  const doc = await fetch(v.blobUrl)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!doc) return null;
  const items = new Set<string>();
  for (const t of doc.tracks ?? []) items.add(`track:${t.id}`);
  for (const m of doc.marks ?? []) items.add(`mark:${m.id}`);
  itemCache.clear(); // one plan per instance in practice; don't grow
  itemCache.set(key, items);
  return items;
}

type Grouped = Record<
  string,
  {
    votes: Record<string, string>;
    comments: { who: string; text: string; at: string }[];
  }
>;

async function grouped(packId: string): Promise<Grouped> {
  const rows = await db
    .select()
    .from(packFeedback)
    .where(eq(packFeedback.packId, packId))
    .orderBy(packFeedback.updatedAt);
  const out: Grouped = {};
  for (const r of rows) {
    const key = `${r.itemType}:${r.itemId}`;
    out[key] ??= { votes: {}, comments: [] };
    if (r.kind === "vote") out[key].votes[r.voterName] = r.value;
    else
      out[key].comments.push({
        who: r.voterName,
        text: r.value,
        at: r.updatedAt.toISOString(),
      });
  }
  return out;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const pack = await visiblePlan(token);
  if (!pack) {
    return NextResponse.json(
      { ok: false, error: "This plan is no longer shared." },
      { status: 404 },
    );
  }
  await ensureSchema();
  return NextResponse.json({ ok: true, items: await grouped(pack.id) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (limited(req)) {
    return NextResponse.json(
      { ok: false, error: "Too many votes — take a breather." },
      { status: 429 },
    );
  }
  const { token } = await params;
  const pack = await visiblePlan(token);
  if (!pack) {
    return NextResponse.json(
      { ok: false, error: "This plan is no longer shared." },
      { status: 404 },
    );
  }

  const body = await req.json().catch(() => null);
  const itemType = body?.itemType;
  const itemId = body?.itemId;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const vote = body?.vote;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";

  if (itemType !== "track" && itemType !== "mark") {
    return NextResponse.json(
      { ok: false, error: "Bad item type." },
      { status: 400 },
    );
  }
  if (typeof itemId !== "string" || !itemId || itemId.length > 64) {
    return NextResponse.json(
      { ok: false, error: "Bad item id." },
      { status: 400 },
    );
  }
  if (!name || name.length > MAX_NAME) {
    return NextResponse.json(
      { ok: false, error: `Add a name (up to ${MAX_NAME} characters).` },
      { status: 400 },
    );
  }
  const hasVote = vote !== undefined && vote !== null;
  if (hasVote === Boolean(comment)) {
    return NextResponse.json(
      { ok: false, error: "Send a vote or a comment." },
      { status: 400 },
    );
  }
  if (hasVote && !VOTES.includes(vote)) {
    return NextResponse.json(
      { ok: false, error: "Vote must be yes, maybe or no." },
      { status: 400 },
    );
  }
  if (comment.length > MAX_COMMENT) {
    return NextResponse.json(
      { ok: false, error: `Comments max ${MAX_COMMENT} characters.` },
      { status: 400 },
    );
  }

  await ensureSchema();
  const items = await planItems(pack.id, pack.currentVersion);
  if (!items?.has(`${itemType}:${itemId}`)) {
    return NextResponse.json(
      { ok: false, error: "That track isn't in this plan any more — reload." },
      { status: 400 },
    );
  }

  if (comment) {
    await db.insert(packFeedback).values({
      packId: pack.id,
      itemType,
      itemId,
      voterName: name,
      kind: "comment",
      value: comment,
    });
  } else {
    // Same vote again = retract (toggle off); otherwise upsert.
    const [existing] = await db
      .select()
      .from(packFeedback)
      .where(
        and(
          eq(packFeedback.packId, pack.id),
          eq(packFeedback.itemType, itemType),
          eq(packFeedback.itemId, itemId),
          eq(packFeedback.voterName, name),
          eq(packFeedback.kind, "vote"),
        ),
      );
    if (existing && existing.value === vote) {
      await db.delete(packFeedback).where(eq(packFeedback.id, existing.id));
    } else if (existing) {
      await db
        .update(packFeedback)
        .set({ value: vote, updatedAt: new Date() })
        .where(eq(packFeedback.id, existing.id));
    } else {
      await db.insert(packFeedback).values({
        packId: pack.id,
        itemType,
        itemId,
        voterName: name,
        kind: "vote",
        value: vote,
      });
    }
  }

  return NextResponse.json({ ok: true, items: await grouped(pack.id) });
}
