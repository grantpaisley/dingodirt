import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.fn();
const selectMock = vi.fn();
const executeMock = vi.fn();
const cookieMock = vi.fn<() => { name: string }[]>();

vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => selectMock() }),
    }),
    execute: () => executeMock(),
  },
}));
vi.mock("@/db/schema", () => ({ allowlist: { email: "email" } }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => cookieMock() }),
}));

function reset() {
  authMock.mockReset();
  selectMock.mockReset();
  executeMock.mockReset().mockResolvedValue([{ "?column?": 1 }]);
  cookieMock.mockReset().mockReturnValue([]);
}

const SESSION = { user: { id: "u1", email: "Boss@Example.com", name: "Boss" } };

async function subject() {
  return import("./membership");
}

describe("currentUser", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reset();
  });

  it("reads the role from the allowlist", async () => {
    authMock.mockResolvedValue(SESSION);
    selectMock.mockResolvedValue([{ role: "trusted" }]);
    const { currentUser } = await subject();

    const user = await currentUser();

    expect(user).toMatchObject({ email: "boss@example.com", role: "trusted" });
  });

  it("is a plain user when the allowlist has no entry", async () => {
    authMock.mockResolvedValue(SESSION);
    selectMock.mockResolvedValue([]);
    const { currentUser } = await subject();

    expect(await currentUser()).toMatchObject({ role: "user" });
  });

  it("refuses to guess the role when the database is unreachable", async () => {
    authMock.mockResolvedValue(SESSION);
    selectMock.mockRejectedValue(new Error("connection refused"));
    const { currentUser, MembershipUnavailableError } = await subject();

    // The old code returned role "user" here, which quietly demoted admins
    // and pushed a trusted user's public pack into the review queue.
    await expect(currentUser()).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
  });

  it("is null when nobody is signed in", async () => {
    authMock.mockResolvedValue(null);
    const { currentUser } = await subject();

    expect(await currentUser()).toBeNull();
  });

  it("is null for a stale cookie while the database is up", async () => {
    authMock.mockResolvedValue(null);
    cookieMock.mockReturnValue([{ name: "authjs.session-token" }]);
    const { currentUser } = await subject();

    expect(await currentUser()).toBeNull();
  });

  it("does not call a signed-in member signed out during an outage", async () => {
    // Auth.js catches a failed session read and reports no session at all,
    // so a cookie plus an unreachable database must not read as "signed out".
    authMock.mockResolvedValue(null);
    cookieMock.mockReturnValue([{ name: "__Secure-authjs.session-token.0" }]);
    executeMock.mockRejectedValue(new Error("connection refused"));
    const { currentUser, MembershipUnavailableError } = await subject();

    await expect(currentUser()).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
  });
});

describe("viewerIdentity", () => {
  beforeEach(() => {
    reset();
  });

  it("never touches the allowlist, so it carries no role", async () => {
    authMock.mockResolvedValue(SESSION);
    const { viewerIdentity } = await subject();

    const viewer = await viewerIdentity();

    expect(viewer).toEqual({
      id: "u1",
      email: "boss@example.com",
      name: "Boss",
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("is null, not an exception, when the session store is down", async () => {
    authMock.mockRejectedValue(new Error("connection refused"));
    const { viewerIdentity } = await subject();

    expect(await viewerIdentity()).toBeNull();
  });
});

describe("displayUser", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reset();
  });

  it("drops to identity without a role when the allowlist is down", async () => {
    authMock.mockResolvedValue(SESSION);
    selectMock.mockRejectedValue(new Error("connection refused"));
    const { displayUser } = await subject();

    const user = await displayUser();

    expect(user).toMatchObject({ id: "u1" });
    expect(user).not.toHaveProperty("role");
  });
});
