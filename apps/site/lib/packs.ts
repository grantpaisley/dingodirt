import { randomBytes, createHash } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { put } from "@vercel/blob";
import { db } from "@/db";
import { packs, packVersions } from "@/db/schema";
import {
  validatePack,
  slugify,
  PackValidationError,
} from "@/lib/validate-pack";
import type { SessionUser } from "@/lib/membership";

export { PackValidationError };

export function newShareToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * A plain user asking for "public" lands in the review queue ("pending");
 * trusted/admin go straight to public. Other visibilities pass through.
 */
export function resolveVisibilityRequest(
  requested: "private" | "unlisted" | "public",
  trusted: boolean,
): "private" | "unlisted" | "pending" | "public" {
  return requested === "public" && !trusted ? "pending" : requested;
}

function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export class StorageUnavailableError extends Error {}

/**
 * Upload a pack for `user`. If the user already owns a non-deleted pack with
 * the same name+type, this becomes a version bump (same share link).
 */
export async function publishPack(
  user: SessionUser,
  buf: Buffer,
  filename: string,
) {
  const validated = validatePack(buf, filename);
  if (!blobConfigured()) {
    throw new StorageUnavailableError(
      "Pack storage isn't configured on this deployment yet.",
    );
  }

  const checksum = createHash("sha256").update(buf).digest("hex");

  const [existing] = await db
    .select()
    .from(packs)
    .where(
      and(
        eq(packs.ownerId, user.id),
        eq(packs.name, validated.name),
        eq(packs.type, validated.type),
        isNull(packs.deletedAt),
      ),
    );

  const version = existing ? existing.currentVersion + 1 : 1;
  const packId = existing ? existing.id : crypto.randomUUID();
  const ext = validated.type === "ride" ? "dingonav" : "dingoscheme";

  const blob = await put(
    `packs/${packId}/v${version}.${ext}`,
    buf,
    { access: "public", addRandomSuffix: true },
  );

  let previewUrl: string | null = null;
  if (validated.preview) {
    const p = await put(
      `packs/${packId}/v${version}-preview.png`,
      validated.preview,
      { access: "public", addRandomSuffix: true },
    );
    previewUrl = p.url;
  }

  const storedMeta = JSON.stringify(
    validated.legacyTiles
      ? { ...validated.metadata, _legacyTiles: true }
      : validated.metadata,
  );

  if (existing) {
    await db.insert(packVersions).values({
      packId,
      version,
      blobUrl: blob.url,
      previewUrl,
      size: buf.length,
      checksum,
      metadata: storedMeta,
    });
    await db
      .update(packs)
      .set({ currentVersion: version, updatedAt: new Date() })
      .where(eq(packs.id, packId));
    return { pack: existing, version, isNew: false };
  }

  // New pack: unique slug (suffix on collision with anyone's pack).
  const base = slugify(validated.name);
  let slug = base;
  for (let i = 2; ; i++) {
    const [clash] = await db
      .select({ id: packs.id })
      .from(packs)
      .where(eq(packs.slug, slug));
    if (!clash) break;
    slug = `${base}-${i}`;
  }

  const [pack] = await db
    .insert(packs)
    .values({
      id: packId,
      ownerId: user.id,
      type: validated.type,
      name: validated.name,
      slug,
      shareToken: newShareToken(),
      authorName: user.name,
    })
    .returning();

  await db.insert(packVersions).values({
    packId,
    version: 1,
    blobUrl: blob.url,
    previewUrl,
    size: buf.length,
    checksum,
    metadata: storedMeta,
  });

  return { pack, version: 1, isNew: true };
}

/** Resolve a live (non-deleted) pack by share token or public slug. */
export async function packByToken(token: string) {
  const [pack] = await db
    .select()
    .from(packs)
    .where(and(eq(packs.shareToken, token), isNull(packs.deletedAt)));
  if (pack) return pack;
  const [bySlug] = await db
    .select()
    .from(packs)
    .where(
      and(
        eq(packs.slug, token),
        eq(packs.visibility, "public"),
        isNull(packs.deletedAt),
      ),
    );
  return bySlug ?? null;
}

export async function currentVersionOf(packId: string, version: number) {
  const [v] = await db
    .select()
    .from(packVersions)
    .where(
      and(eq(packVersions.packId, packId), eq(packVersions.version, version)),
    );
  return v ?? null;
}

export async function countDownload(packId: string) {
  await db
    .update(packs)
    .set({ downloads: sql`${packs.downloads} + 1` })
    .where(eq(packs.id, packId));
}
