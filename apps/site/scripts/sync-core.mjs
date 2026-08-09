// Copy the shared core/ pieces the site needs into the app tree.
// The site is a standalone Next package (no workspace), so it can't import
// ../../core directly and Vercel's static upload doesn't follow symlinks —
// a predev/prebuild copy is the deterministic path. Outputs are gitignored;
// core/ stays the only editable source (see core/appliers/detail.js header).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = dirname(dirname(fileURLToPath(import.meta.url)));
const core = join(site, "..", "..", "core");

// Style appliers (plain ESM + .d.ts) → lib/core/
mkdirSync(join(site, "lib", "core"), { recursive: true });
for (const f of ["applier-nav.js", "applier-nav.d.ts", "detail.js", "detail.d.ts", "scheme.js", "scheme.d.ts"]) {
  cpSync(join(core, "appliers", f), join(site, "lib", "core", f));
}

// Basemap layer files + glyphs + sprites → public/basemap/
const pub = join(site, "public", "basemap");
mkdirSync(pub, { recursive: true });
for (const f of ["layers.json", "layers-light.json"]) {
  cpSync(join(core, "basemap", f), join(pub, f));
}
for (const d of ["fonts", "sprites"]) {
  cpSync(join(core, "basemap", d), join(pub, d), { recursive: true });
}

console.log("sync-core: appliers → lib/core, basemap assets → public/basemap");
