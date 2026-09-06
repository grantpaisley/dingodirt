import { eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { allowlist } from "@/db/schema";
import { outageJson, reportOutage } from "@/lib/alert";

// Every signed-in user can publish. "trusted" skips the public-listing
// review queue; "admin" moderates.
export type Role = "user" | "trusted" | "admin";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** Who is signed in, with no role attached. */
export type Viewer = Omit<SessionUser, "role">;

/** A viewer plus the role, when the role could be read. */
export type DisplayUser = Viewer & { role?: Role };

/** The role could not be read, so no permission decision is safe. */
export class MembershipUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Could not read the signed-in user's role.");
    this.name = "MembershipUnavailableError";
    this.cause = cause;
  }
}

/** Auth.js session cookies, including the numbered chunks of a large one. */
const SESSION_COOKIE_RE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

async function sentSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return jar.getAll().some((c) => SESSION_COOKIE_RE.test(c.name));
}

async function databaseReachable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

async function sessionViewer(): Promise<Viewer | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!session?.user || !email) return null;
  return {
    id: (session.user as { id?: string }).id ?? "",
    email: email.toLowerCase(),
    name: session.user.name ?? email,
  };
}

/**
 * Identity only — no role. Use it for owner checks, which compare ids, and
 * for showing a name. It answers null instead of throwing when the session
 * store is unreachable, because it renders on the outage page itself.
 * Never decide what somebody may do from this.
 */
export async function viewerIdentity(): Promise<Viewer | null> {
  try {
    return await sessionViewer();
  } catch (err) {
    unstable_rethrow(err);
    return null;
  }
}

/**
 * The signed-in user with an authoritative role, or null if nobody is signed
 * in. Throws MembershipUnavailableError when the role cannot be read.
 *
 * The role must never be guessed. A trusted user quietly demoted to "user"
 * has their public pack pushed into the review queue, and an admin quietly
 * demoted is told they may not moderate — both while the site reports no
 * fault at all. Callers answer "unavailable" instead.
 */
export async function currentUser(): Promise<SessionUser | null> {
  let viewer: Viewer | null;
  try {
    viewer = await sessionViewer();
  } catch (err) {
    unstable_rethrow(err);
    throw new MembershipUnavailableError(err);
  }
  if (!viewer) {
    // Auth.js catches a failed session read and reports "signed out" instead
    // of throwing, so a null session is ambiguous whenever the browser sent a
    // cookie: either the session is stale, or the store is unreachable. One
    // cheap probe settles it, rather than telling a signed-in member to sign
    // in while the database is down.
    if ((await sentSessionCookie()) && !(await databaseReachable())) {
      throw new MembershipUnavailableError(
        new Error("session store unreachable"),
      );
    }
    return null;
  }

  try {
    const [entry] = await db
      .select()
      .from(allowlist)
      .where(eq(allowlist.email, viewer.email));
    return { ...viewer, role: entry ? entry.role : "user" };
  } catch (err) {
    throw new MembershipUnavailableError(err);
  }
}

/**
 * For page chrome that must render even during an outage: the full user when
 * the role is readable, identity alone when it is not. A missing role hides
 * role-gated links, which is correct — the pages behind them answer 503.
 */
export async function displayUser(): Promise<DisplayUser | null> {
  try {
    return await currentUser();
  } catch (err) {
    unstable_rethrow(err);
    return viewerIdentity();
  }
}

/**
 * currentUser() for API routes. A failed role read becomes the shared 503
 * response, which the caller returns as-is, and the operator is mailed.
 */
export async function currentUserOr503(
  where: string,
): Promise<SessionUser | null | NextResponse> {
  try {
    return await currentUser();
  } catch (err) {
    await reportOutage(where, err);
    return outageJson();
  }
}

export function isTrusted(u: SessionUser | null): u is SessionUser {
  return !!u && (u.role === "trusted" || u.role === "admin");
}

export function isAdmin(u: SessionUser | null): u is SessionUser {
  return !!u && u.role === "admin";
}
