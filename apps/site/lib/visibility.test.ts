import { describe, it, expect } from "vitest";
import { nextVisibility, resolveVisibilityRequest } from "./packs";

describe("resolveVisibilityRequest", () => {
  it("queues a plain user's public request as pending", () => {
    expect(resolveVisibilityRequest("public", false)).toBe("pending");
  });

  it("lets trusted users go straight to public", () => {
    expect(resolveVisibilityRequest("public", true)).toBe("public");
  });

  it("passes private and unlisted through for everyone", () => {
    expect(resolveVisibilityRequest("private", false)).toBe("private");
    expect(resolveVisibilityRequest("unlisted", false)).toBe("unlisted");
    expect(resolveVisibilityRequest("private", true)).toBe("private");
    expect(resolveVisibilityRequest("unlisted", true)).toBe("unlisted");
  });
});

describe("nextVisibility (publish/refresh)", () => {
  it("leaves visibility alone when nothing was requested", () => {
    expect(nextVisibility("public", undefined, false)).toBeUndefined();
    expect(nextVisibility(null, undefined, true)).toBeUndefined();
  });

  it("queues an untrusted public request on new and unlisted packs", () => {
    expect(nextVisibility(null, "public", false)).toBe("pending");
    expect(nextVisibility("unlisted", "public", false)).toBe("pending");
  });

  it("never knocks an approved public pack back into the queue", () => {
    expect(nextVisibility("public", "public", false)).toBe("public");
  });

  it("lets the owner delist an approved pack", () => {
    expect(nextVisibility("public", "unlisted", false)).toBe("unlisted");
  });

  it("keeps a pending request pending on refresh", () => {
    expect(nextVisibility("pending", "public", false)).toBe("pending");
  });

  it("trusted users publish straight to public", () => {
    expect(nextVisibility(null, "public", true)).toBe("public");
    expect(nextVisibility("pending", "public", true)).toBe("public");
  });
});
