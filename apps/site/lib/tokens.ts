import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiTokens, users, allowlist } from "@/db/schema";
import { currentUser, type Role, type SessionUser } from "@/lib/membership";
import { TOKEN_PREFIX, hashToken, newTokenSecret } from "@/lib/token-crypto";

export { TOKEN_PREFIX, hashToken, newTokenSecret };

export async function listApiTokens(userId: string) {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
}

/** Create a token; the returned secret is the only time it exists in full. */
export async function createApiToken(userId: string, name: string) {
  const secret = newTokenSecret();
  const [row] = await db
    .insert(apiTokens)
    .values({ userId, name, tokenHash: hashToken(secret) })
    .returning();
  return { secret, row };
}

/** Revoke (soft) so the dashboard can still show when it was last used. */
export async function revokeApiToken(userId: string, id: string) {
  const [row] = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .returning();
  return !!row;
}

/**
 * Resolve a Bearer secret to the same SessionUser shape the cookie path
 * produces, so everything downstream of the upload route is agnostic to how
 * the caller authenticated. Returns null for unknown/revoked tokens.
 */
/** Bearer token when present, session cookie otherwise. */
export async function requestUser(req: {
  headers: { get(name: string): string | null };
}): Promise<SessionUser | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return userForToken(auth.slice(7)).catch(() => null);
  }
  return currentUser();
}

export async function userForToken(
  secret: string,
): Promise<SessionUser | null> {
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const [hit] = await db
    .select({
      tokenId: apiTokens.id,
      userId: apiTokens.userId,
      name: users.name,
      email: users.email,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(secret)),
        isNull(apiTokens.revokedAt),
      ),
    );
  if (!hit || !hit.email) return null;

  const email = hit.email.toLowerCase();
  let role: Role = "user";
  try {
    const [entry] = await db
      .select()
      .from(allowlist)
      .where(eq(allowlist.email, email));
    if (entry) role = entry.role;
  } catch {
    // DB hiccup on the role lookup → plain user, same as the cookie path.
  }

  db.update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, hit.tokenId))
    .catch(() => {});

  return { id: hit.userId, email, name: hit.name ?? email, role };
}
