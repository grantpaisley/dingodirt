import AdmZip from "adm-zip";

export const MAX_PACK_BYTES = 50 * 1024 * 1024;
export const SUPPORTED_SCHEMA_MAJOR = 1;

export type PackType = "ride" | "scheme";

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
 * Validate an uploaded pack zip and extract its manifest + preview.
 * `.dingonav` (ride) → bundle.json; `.dingoscheme` → scheme.json (+ preview.png).
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
  let type: PackType;
  if (lower.endsWith(".dingonav")) type = "ride";
  else if (lower.endsWith(".dingoscheme")) type = "scheme";
  else {
    throw new PackValidationError(
      "Expected a .dingonav or .dingoscheme file.",
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
