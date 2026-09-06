import { describe, it, expect } from "vitest";
import {
  buildRouteGpx,
  computeRoute,
  decodePolyline,
  isGmapsHost,
  parseDirUrl,
  resolveUrl,
  routeTitle,
} from "./gmaps";
import { createRateLimiter } from "./ratelimit";

// The same fixtures as core/rust/google/src/maps.rs — the two parsers must
// not drift apart. Grant's example: the Greenbank Dr loop, resolved from
// https://maps.app.goo.gl/452uG78w5P8SiX416
const GREENBANK =
  "https://www.google.com/maps/dir/90+Greenbank+Dr/Northholm+Grammar+School/ALDI/90+Greenbank+Dr/data=!4m28!4m27!1m5!1m4!1s0x6b12a05696d06f8f:0xab2056fba01097f!8m2!3d-33.7061969!4d150.99651559999998!1m5!1m4!1s0x6b0d5bfd9a027ccb:0x2ec06aa905ec3e31!8m2!3d-33.604513!4d151.0540723!1m5!1m4!1s0x6b0d5f2d5acf5e0b:0x130eff4389d855dc!8m2!3d-33.652563!4d151.046464!1m5!1m4!1s0x6b12a05696d06f8f:0xab2056fba01097f!8m2!3d-33.7061969!4d150.99651559999998!2m1!11b1!3e0?utm_source=mstt_0";

describe("parseDirUrl", () => {
  it("parses the Greenbank loop", () => {
    const req = parseDirUrl(GREENBANK);
    expect(req.travelMode).toBe("DRIVE");
    expect(req.waypoints).toHaveLength(4);
    expect(req.waypoints[0]!.name).toBe("90 Greenbank Dr");
    expect(req.waypoints[1]!.name).toBe("Northholm Grammar School");
    expect(req.waypoints[2]!.name).toBe("ALDI");
    const [lat, lon] = req.waypoints[0]!.coord!;
    expect(lat).toBeCloseTo(-33.7061969, 6);
    expect(lon).toBeCloseTo(150.9965156, 6);
    expect(req.waypoints[2]!.coord![0]).toBeCloseTo(-33.652563, 6);
  });

  it("reads cycling mode and stops at the viewport segment", () => {
    const req = parseDirUrl(
      "https://www.google.com/maps/dir/A+St/B+Rd/@-33.7,151.0,12z/data=!3e1",
    );
    expect(req.travelMode).toBe("BICYCLE");
    expect(req.waypoints).toHaveLength(2);
    expect(req.waypoints[0]!.coord).toBeNull();
  });

  it("parses raw lat,lng stops as coordinates", () => {
    const req = parseDirUrl(
      "https://www.google.com/maps/dir/-33.70,150.99/-33.60,151.05/",
    );
    expect(req.waypoints[0]!.coord).toEqual([-33.7, 150.99]);
    expect(req.waypoints[1]!.coord).toEqual([-33.6, 151.05]);
  });

  it("rejects a place link", () => {
    expect(() => parseDirUrl("https://www.google.com/maps/place/Sydney")).toThrow(
      /directions link/,
    );
  });
});

describe("decodePolyline", () => {
  it("round-trips Google's documented example", () => {
    // (38.5,-120.2) (40.7,-120.95) (43.252,-126.453)
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toHaveLength(3);
    expect(pts[0]![0]).toBeCloseTo(38.5, 9);
    expect(pts[0]![1]).toBeCloseTo(-120.2, 9);
    expect(pts[2]![0]).toBeCloseTo(43.252, 9);
    expect(pts[2]![1]).toBeCloseTo(-126.453, 9);
  });
});

describe("buildRouteGpx", () => {
  it("has no timestamps and carries the source and title", () => {
    const req = parseDirUrl(GREENBANK);
    const gpx = buildRouteGpx(req, "https://maps.app.goo.gl/x", [
      [-33.7, 150.99],
      [-33.6, 151.05],
    ]);
    expect(gpx).toContain('<trkpt lat="-33.70000" lon="150.99000">');
    expect(gpx).not.toContain("<time>");
    expect(gpx).toContain("Imported from Google Maps: https://maps.app.goo.gl/x");
    expect(gpx).toContain("90 Greenbank Dr loop via Northholm Grammar School");
  });

  it("escapes markup in stop names", () => {
    const gpx = buildRouteGpx(
      { waypoints: [{ name: "A & B <x>", coord: null }, { name: "C", coord: null }], travelMode: "DRIVE" },
      "https://maps.app.goo.gl/x",
      [[0, 0], [1, 1]],
    );
    expect(gpx).toContain("<name>A &amp; B &lt;x&gt; to C</name>");
  });
});

describe("routeTitle", () => {
  it("names loops, point-to-points and degenerate cases", () => {
    expect(routeTitle([])).toBe("Google Maps route");
    expect(routeTitle(["A"])).toBe("Google Maps route: A");
    expect(routeTitle(["A", "B"])).toBe("A to B");
    expect(routeTitle(["A", "B", "A"])).toBe("A loop via B");
    expect(routeTitle(["A", "A"])).toBe("A to A");
  });
});

describe("isGmapsHost", () => {
  it("accepts Google's hosts only", () => {
    expect(isGmapsHost("https://maps.app.goo.gl/452uG78w5P8SiX416")).toBe(true);
    expect(isGmapsHost("https://www.google.com/maps/dir/A/B")).toBe(true);
    expect(isGmapsHost("https://maps.google.com/x")).toBe(true);
    expect(isGmapsHost("https://evil.com/maps/dir/A/B")).toBe(false);
    expect(isGmapsHost("https://google.com@evil.com/maps/dir/")).toBe(false);
    expect(isGmapsHost("https://notgoogle.com/maps")).toBe(false);
    expect(isGmapsHost("ftp://www.google.com/maps")).toBe(false);
    expect(isGmapsHost("javascript:alert(1)")).toBe(false);
  });
});

describe("resolveUrl", () => {
  it("passes full directions links through without fetching", async () => {
    const fetchImpl = (() => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    expect(await resolveUrl(GREENBANK, fetchImpl)).toBe(GREENBANK);
  });

  it("returns the redirected URL for a short link", async () => {
    const fetchImpl = (async () =>
      ({ url: GREENBANK }) as Response) as unknown as typeof fetch;
    expect(await resolveUrl("https://maps.app.goo.gl/abc", fetchImpl)).toBe(GREENBANK);
  });
});

describe("computeRoute", () => {
  it("sends stops in order and decodes the polyline", async () => {
    let sent: unknown = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [{ polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" } }],
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const req = parseDirUrl(GREENBANK);
    const pts = await computeRoute(req, "key", fetchImpl);
    expect(pts).toHaveLength(3);
    const body = sent as {
      origin: { location: { latLng: { latitude: number } } };
      intermediates: unknown[];
      travelMode: string;
    };
    expect(body.origin.location.latLng.latitude).toBeCloseTo(-33.7061969, 6);
    expect(body.intermediates).toHaveLength(2);
    expect(body.travelMode).toBe("DRIVE");
  });

  it("surfaces the API's error message", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "API key not valid" } }),
      }) as Response) as unknown as typeof fetch;
    await expect(
      computeRoute(parseDirUrl(GREENBANK), "bad", fetchImpl),
    ).rejects.toThrow(/403.*API key not valid/);
  });
});

describe("createRateLimiter", () => {
  it("caps hits per key per window", () => {
    const rl = createRateLimiter(2, 1000);
    expect(rl.hit("a", 0)).toBe(false);
    expect(rl.hit("a", 1)).toBe(false);
    expect(rl.hit("a", 2)).toBe(true);
    expect(rl.hit("b", 2)).toBe(false);
    expect(rl.hit("a", 1001)).toBe(false); // window rolled
  });
});
