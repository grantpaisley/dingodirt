import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { allowlist } from "@/db/schema";

// Every signed-in user can publish. "trusted" skips the public-listing
// review queue; "admin" moderates.
export type Role = "user" | "trusted" | "admin";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!session?.user || !email) return null;
  let role: Role = "user";
  try {
    const [entry] = await db
      .select()
      .from(allowlist)
      .where(eq(allowlist.email, email.toLowerCase()));
    if (entry) role = entry.role;
  } catch {
    // DB unreachable → plain user; pages still render.
  }
  return {
    id: (session.user as { id?: string }).id ?? "",
    email: email.toLowerCase(),
    name: session.user.name ?? email,
    role,
  };
}

export function isTrusted(u: SessionUser | null): u is SessionUser {
  return !!u && (u.role === "trusted" || u.role === "admin");
}

export function isAdmin(u: SessionUser | null): u is SessionUser {
  return !!u && u.role === "admin";
}
