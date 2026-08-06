import { createHash, randomBytes } from "crypto";

// Pure secret/hash helpers, kept free of DB and auth imports so tests can
// load them without dragging in the next-auth stack.

// The prefix makes a leaked secret grep-able and tells the daemon it's
// looking at a dingodirt token rather than random noise.
export const TOKEN_PREFIX = "ddt_";

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function newTokenSecret(): string {
  return TOKEN_PREFIX + randomBytes(24).toString("base64url");
}
