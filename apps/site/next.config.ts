import path from "node:path";
import type { NextConfig } from "next";

// The monorepo root is the filesystem root for bundling, so pages can
// import shared CSS from core/ui (one canonical copy — see
// docs/plans/2026-08-09-ui-shared-library-design.md). Without this,
// Turbopack panics on any import that leaves apps/site.
const monorepoRoot = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
};

export default nextConfig;
