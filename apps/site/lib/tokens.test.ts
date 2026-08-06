import { describe, it, expect } from "vitest";
import { hashToken, newTokenSecret, TOKEN_PREFIX } from "./tokens";

describe("api token secrets", () => {
  it("mints prefixed, unique, url-safe secrets", () => {
    const a = newTokenSecret();
    const b = newTokenSecret();
    expect(a).toMatch(new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{32}$`));
    expect(a).not.toBe(b);
  });

  it("hashes deterministically and never stores the secret shape", () => {
    const secret = newTokenSecret();
    expect(hashToken(secret)).toBe(hashToken(secret));
    expect(hashToken(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(secret)).not.toContain(TOKEN_PREFIX);
  });
});
