import AdmZip from "adm-zip";

export const MAX_PACK_BYTES = 50 * 1024 * 1024;
export const MAX_PLAN_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_SCHEMA_MAJOR = 1;
export const SUPPORTED_PLAN_SCHEMA_MAJOR = 1;

export type PackType = "ride" | "scheme" | "plan";

export interface ValidatedPack {
  type: PackType;
  name: string;
  metadata: Record<string, unknown>;
  preview: Buffer | null;
  /** v1 pack with embedded tiles (basemap/hillshade/satellite) — accepted
   *  for back-compat, badged "legacy" so v2 becomes the norm socially. */
  legacyTiles: boolean;
}

export class PackValidationError extends Error {}

/**
 * Validate an uploaded pack and extract its manifest + preview.
 * `.dingonav` (ride) → zip with bundle.json; `.dingoscheme` → zip with
 * scheme.json (+ preview.png); `.dingoplan` (plan) → bare JSON planning
 * doc (docs/plans/2026-08-07-planning-mode-design.md).
 * Throws PackValidationError with a plain, user-facing message.
 */
export function validatePack(buf: Buffer, filename: string): ValidatedPack {
  if (buf.length === 0) throw new PackValidationError("The file is empty.");
  if (buf.length > MAX_PACK_BYTES) {
    throw new PackValidationError(
      `Pack is too big (max ${MAX_PACK_BYTES / 1024 / 1024} MB).`,
    );
  }

  const lower = filename.toLowerCase();
  if (lower.endsWith(".dingoplan")) return validatePlan(buf, filename);
  let type: PackType;
  if (lower.endsWith(".dingonav")) type = "ride";
  else if (lower.endsWith(".dingoscheme")) type = "scheme";
  else {
    throw new PackValidationError(
      "Expected a .dingonav, .dingoscheme or .dingoplan file.",
    );
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
    zip.getEntries();
  } catch {
    throw new PackValidationError("That file isn't a valid pack (not a zip).");
  }

  const manifestName = type === "ride" ? "bundle.json" : "scheme.json";
  const manifestEntry = zip.getEntry(manifestName);
  if (!manifestEntry) {
    throw new PackValidationError(`Pack is missing ${manifestName}.`);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString("utf-8"));
  } catch {
    throw new PackValidationError(`${manifestName} isn't valid JSON.`);
  }

  if (type === "scheme") {
    const sv = manifest.schemaVersion;
    const major =
      typeof sv === "number"
        ? Math.floor(sv)
        : typeof sv === "string"
          ? parseInt(sv, 10)
          : NaN;
    if (!Number.isNaN(major) && major > SUPPORTED_SCHEMA_MAJOR) {
      throw new PackValidationError(
        `This scheme needs a newer schema (v${major}) than the site supports (v${SUPPORTED_SCHEMA_MAJOR}).`,
      );
    }
  }

  const name =
    (typeof manifest.name === "string" && manifest.name.trim()) ||
    filename.replace(/\.(dingonav|dingoscheme)$/i, "");

  const previewEntry = zip.getEntry("preview.png");
  const preview = previewEntry ? previewEntry.getData() : null;

  const legacyTiles =
    type === "ride" &&
    zip
      .getEntries()
      .some(
        (e) =>
          e.entryName === "basemap.pmtiles" ||
          e.entryName === "hillshade.pmtiles" ||
          e.entryName.startsWith("satellite/"),
      );

  return { type, name, metadata: manifest, preview, legacyTiles };
}

/** A `.dingoplan` planning doc: bare JSON, no zip. The full doc is the
 *  blob; metadata keeps only a summary for the pack page / gallery. */
function validatePlan(buf: Buffer, filename: string): ValidatedPack {
  if (buf.length > MAX_PLAN_BYTES) {
    throw new PackValidationError(
      `Plan is too big (max ${MAX_PLAN_BYTES / 1024 / 1024} MB).`,
    );
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(buf.toString("utf-8"));
  } catch {
    throw new PackValidationError("That file isn't a valid plan (not JSON).");
  }
  if (doc.format !== "dingoplan") {
    throw new PackValidationError("That file isn't a dingoplan document.");
  }

  const sv = doc.schemaVersion;
  const major =
    typeof sv === "number"
      ? Math.floor(sv)
      : typeof sv === "string"
        ? parseInt(sv, 10)
        : NaN;
  if (!Number.isNaN(major) && major > SUPPORTED_PLAN_SCHEMA_MAJOR) {
    throw new PackValidationError(
      `This plan needs a newer schema (v${major}) than the site supports (v${SUPPORTED_PLAN_SCHEMA_MAJOR}).`,
    );
  }

  const tracks = Array.isArray(doc.tracks) ? doc.tracks : [];
  if (tracks.length === 0) {
    throw new PackValidationError("The plan has no tracks.");
  }
  const badTrack = tracks.find(
    (t) =>
      typeof t !== "object" ||
      t === null ||
      typeof (t as Record<string, unknown>).id !== "string" ||
      typeof (t as Record<string, unknown>).name !== "string" ||
      typeof (t as Record<string, unknown>).geometry !== "object",
  );
  if (badTrack !== undefined) {
    throw new PackValidationError(
      "A plan track is missing its id, name or geometry.",
    );
  }

  const name =
    (typeof doc.name === "string" && doc.name.trim()) ||
    filename.replace(/\.dingoplan$/i, "");
  const marks = Array.isArray(doc.marks) ? doc.marks : [];
  const km = tracks.reduce(
    (s, t) => s + (typeof (t as Record<string, unknown>).km === "number"
      ? ((t as Record<string, unknown>).km as number)
      : 0),
    0,
  );

  return {
    type: "plan",
    name,
    metadata: {
      tracks: tracks.length,
      marks: marks.length,
      total_km: Math.round(km),
    },
    preview: null,
    legacyTiles: false,
  };
}

/** URL-safe slug; caller ensures uniqueness (suffix on collision). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "pack"
  );
}
