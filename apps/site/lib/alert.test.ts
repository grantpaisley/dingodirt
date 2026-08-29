import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Each test gets a fresh module so the per-instance throttle starts at zero.
async function freshAlert() {
  vi.resetModules();
  return (await import("./alert")).reportOutage;
}

function okFetch() {
  return vi.fn(async () => new Response("{}", { status: 200 }));
}

describe("reportOutage", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.RESEND_API_KEY = "re_test";
    process.env.ALERT_TO = "grant@angrykoala.com.au";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_TO;
  });

  it("sends to the operator with the failing path in the subject", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const reportOutage = await freshAlert();

    await reportOutage("/p/abc", new Error("connection refused"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["grant@angrykoala.com.au"]);
    expect(body.subject).toContain("/p/abc");
    expect(body.text).toContain("connection refused");
  });

  it("stays quiet without an API key", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const reportOutage = await freshAlert();

    await reportOutage("/p/abc", new Error("boom"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends once per window, not once per request", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const reportOutage = await freshAlert();

    await reportOutage("/p/abc", new Error("boom"));
    await reportOutage("/p/def", new Error("boom"));
    await reportOutage("/api/gallery", new Error("boom"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on the next failure when the mail was rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reportOutage = await freshAlert();

    await reportOutage("/p/abc", new Error("boom"));
    await reportOutage("/p/abc", new Error("boom"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws when the mail transport is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const reportOutage = await freshAlert();

    await expect(
      reportOutage("/p/abc", new Error("boom")),
    ).resolves.toBeUndefined();
  });
});
