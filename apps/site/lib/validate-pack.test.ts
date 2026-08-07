import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import {
  validatePack,
  PackValidationError,
  slugify,
  MAX_PACK_BYTES,
} from "./validate-pack";

function zipOf(entries: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(
      name,
      typeof content === "string" ? Buffer.from(content) : content,
    );
  }
  return zip.toBuffer();
}

describe("validatePack", () => {
  it("accepts a good ride pack", () => {
    const buf = zipOf({
      "bundle.json": JSON.stringify({ name: "Kandos Loop", version: 1 }),
    });
    const result = validatePack(buf, "kandos.dingonav");
    expect(result.type).toBe("ride");
    expect(result.name).toBe("Kandos Loop");
    expect(result.preview).toBeNull();
    expect(result.legacyTiles).toBe(false);
  });

  it("flags v1 packs with embedded tiles as legacy", () => {
    const buf = zipOf({
      "bundle.json": JSON.stringify({ name: "Old Pack" }),
      "basemap.pmtiles": Buffer.from("PMTiles-ish"),
      "satellite/12/1/2.jpg": Buffer.from([0xff]),
    });
    expect(validatePack(buf, "old.dingonav").legacyTiles).toBe(true);
  });

  it("accepts a good scheme pack with preview", () => {
    const buf = zipOf({
      "scheme.json": JSON.stringify({ name: "Night Rider", schemaVersion: 1 }),
      "preview.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const result = validatePack(buf, "night-rider.dingoscheme");
    expect(result.type).toBe("scheme");
    expect(result.name).toBe("Night Rider");
    expect(result.preview).not.toBeNull();
  });

  it("rejects unknown extensions", () => {
    expect(() => validatePack(zipOf({}), "pack.zip")).toThrow(
      PackValidationError,
    );
  });

  it("rejects non-zip data", () => {
    expect(() =>
      validatePack(Buffer.from("not a zip at all"), "x.dingonav"),
    ).toThrow(PackValidationError);
  });

  it("rejects a truncated zip", () => {
    const good = zipOf({ "bundle.json": "{}" });
    const truncated = good.subarray(0, Math.floor(good.length / 2));
    expect(() => validatePack(Buffer.from(truncated), "x.dingonav")).toThrow(
      PackValidationError,
    );
  });

  it("rejects oversized packs", () => {
    const buf = Buffer.alloc(MAX_PACK_BYTES + 1);
    expect(() => validatePack(buf, "x.dingonav")).toThrow(/too big/i);
  });

  it("rejects a ride pack missing bundle.json", () => {
    const buf = zipOf({ "other.json": "{}" });
    expect(() => validatePack(buf, "x.dingonav")).toThrow(/bundle\.json/);
  });

  it("rejects malformed manifest JSON", () => {
    const buf = zipOf({ "bundle.json": "{ nope" });
    expect(() => validatePack(buf, "x.dingonav")).toThrow(/valid JSON/);
  });

  it("rejects a scheme with a newer major schemaVersion", () => {
    const buf = zipOf({
      "scheme.json": JSON.stringify({ name: "Future", schemaVersion: 2 }),
    });
    expect(() => validatePack(buf, "x.dingoscheme")).toThrow(/newer schema/);
  });

  it("falls back to the filename when the manifest has no name", () => {
    const buf = zipOf({ "bundle.json": "{}" });
    const result = validatePack(buf, "Wombeyan_2026-08.dingonav");
    expect(result.name).toBe("Wombeyan_2026-08");
  });
});

describe("validatePack: plan", () => {
  const track = {
    id: "t1",
    name: "Big Desert Goaty",
    km: 220,
    geometry: { type: "LineString", coordinates: [[139.5, -35.3], [139.6, -35.2]] },
  };
  const planOf = (doc: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(doc));

  it("accepts a valid planning doc and summarises metadata", () => {
    const buf = planOf({
      format: "dingoplan",
      schemaVersion: 1,
      name: "Flinders2026",
      tracks: [track, { ...track, id: "t2", km: 80 }],
      marks: [{ id: "m1", name: "Prairie Hotel", lon: 138.4, lat: -31.1 }],
    });
    const result = validatePack(buf, "Flinders2026.dingoplan");
    expect(result.type).toBe("plan");
    expect(result.name).toBe("Flinders2026");
    expect(result.metadata).toEqual({ tracks: 2, marks: 1, total_km: 300 });
    expect(result.legacyTiles).toBe(false);
  });

  it("rejects non-JSON and non-dingoplan documents", () => {
    expect(() => validatePack(Buffer.from("PK\x03\x04"), "x.dingoplan")).toThrow(
      /not JSON/,
    );
    expect(() => validatePack(planOf({ tracks: [track] }), "x.dingoplan")).toThrow(
      /isn't a dingoplan/,
    );
  });

  it("rejects a plan with no tracks or broken tracks", () => {
    expect(() =>
      validatePack(planOf({ format: "dingoplan", tracks: [] }), "x.dingoplan"),
    ).toThrow(/no tracks/);
    expect(() =>
      validatePack(
        planOf({ format: "dingoplan", tracks: [{ id: "t1" }] }),
        "x.dingoplan",
      ),
    ).toThrow(/missing its id, name or geometry/);
  });

  it("rejects a plan with a newer major schemaVersion", () => {
    expect(() =>
      validatePack(
        planOf({ format: "dingoplan", schemaVersion: 2, tracks: [track] }),
        "x.dingoplan",
      ),
    ).toThrow(/newer schema/);
  });
});

describe("slugify", () => {
  it("makes URL-safe slugs", () => {
    expect(slugify("Wombeyan 2026-08!")).toBe("wombeyan-2026-08");
    expect(slugify("  Ödd näme  ")).toBe("dd-n-me");
    expect(slugify("!!!")).toBe("pack");
  });
});
