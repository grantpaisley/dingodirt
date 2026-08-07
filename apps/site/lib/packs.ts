import { randomBytes, createHash } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { copy, del, put } from "@vercel/blob";
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

export type Visibility = "private" | "unlisted" | "pending" | "public";

/**
 * Visibility to store on a publish/refresh; undefined = leave as-is. A
 * refresh that re-asks for "public" on an already-approved pack must not
 * knock it back into the review queue.
 */
export function nextVisibility(
  current: Visibility | null,
  requested: "private" | "unlisted" | "public" | undefined,
  trusted: boolean,
): Visibility | undefined {
  if (!requested) return undefined;
  const resolved = resolveVisibilityRequest(requested, trusted);
  if (resolved === "pending" && current === "public") return "public";
  return resolved;
}

function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export class StorageUnavailableError extends Error {}

export interface PublishOptions {
  /** Requested visibility; omitted = keep current (new packs: schema default). */
  visibility?: "private" | "unlisted" | "public";
  /**
   * Version-bump this exact pack (must be owned by the caller) instead of
   * matching on name+type — so renaming a pack in Plan propagates to the
   * site pack instead of forking a new one.
   */
  packId?: string;
  /**
   * Landing-zone pathname of a bundle already PUT to Blob storage via the
   * presigned flow (/api/packs/upload). The version blob is server-side
   * copied from it instead of re-uploaded, and the landing blob is deleted.
   */
  preUploadedPathname?: string;
}

/**
 * Upload a pack for `user`. `opts.packId` (from the daemon) pins the version
 * bump to that pack; otherwise a non-deleted pack with the same name+type
 * becomes the bump target (same share link either way).
 */
export async function publishPack(
  user: SessionUser,
  buf: Buffer,
  filename: string,
  opts: PublishOptions = {},
) {
  const validated = validatePack(buf, filename);
  if (!blobConfigured()) {
    throw new StorageUnavailableError(
      "Pack storage isn't configured on this deployment yet.",
    );
  }

  const checksum = createHash("sha256").update(buf).digest("hex");

  let existing: typeof packs.$inferSelect | undefined;
  if (opts.packId) {
    [existing] = await db
      .select()
      .from(packs)
      .where(
        and(
          eq(packs.id, opts.packId),
          eq(packs.ownerId, user.id),
          isNull(packs.deletedAt),
        ),
      );
    if (!existing) {
      throw new PackValidationError(
        "Unknown pack id — it may have been deleted on dingodirt.com.",
      );
    }
    if (existing.type !== validated.type) {
      throw new PackValidationError(
        "That pack id belongs to a different pack type.",
      );
    }
  } else {
    [existing] = await db
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
  }

  const trusted = user.role === "trusted" || user.role === "admin";
  const visibility = nextVisibility(
    existing?.visibility ?? null,
    opts.visibility,
    trusted,
  );

  const version = existing ? existing.currentVersion + 1 : 1;
  const packId = existing ? existing.id : crypto.randomUUID();
  const ext =
    validated.type === "ride"
      ? "dingonav"
      : validated.type === "plan"
        ? "dingoplan"
        : "dingoscheme";

  const finalPath = `packs/${packId}/v${version}.${ext}`;
  const blob = opts.preUploadedPathname
    ? await copy(opts.preUploadedPathname, finalPath, {
        access: "public",
        addRandomSuffix: true,
      })
    : await put(finalPath, buf, { access: "public", addRandomSuffix: true });
  if (opts.preUploadedPathname) {
    // Landing blob served its purpose; losing this delete only leaks a file.
    await del(opts.preUploadedPathname).catch(() => {});
  }

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
    // An explicit packId means the caller's name is authoritative (a Plan
    // rename); the slug stays frozen so handed-out links survive.
    const [updated] = await db
      .update(packs)
      .set({
        currentVersion: version,
        updatedAt: new Date(),
        ...(opts.packId && validated.name !== existing.name
          ? { name: validated.name }
          : {}),
        ...(visibility ? { visibility } : {}),
      })
      .where(eq(packs.id, packId))
      .returning();
    return { pack: updated ?? existing, version, isNew: false };
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
      ...(visibility ? { visibility } : {}),
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
