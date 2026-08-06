import { describe, it, expect } from "vitest";
import { resolveVisibilityRequest } from "./packs";

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
