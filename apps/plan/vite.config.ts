import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Plan is served from a subpath on GitHub Pages (/dingodirt/plan/) but from
  // the root in local dev and on any custom domain later. The deploy workflow
  // sets VITE_BASE; everything else gets '/' and behaves exactly as before.
  //
  // Anything reading a public asset at RUNTIME must use import.meta.env.BASE_URL
  // rather than a leading slash — see fetchSchemeIndex in scheme.ts and
  // rebase() in mapStyles.ts. Vite rewrites index.html references itself.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  // Daemon proxy: inert while SERVER_BASE is the default absolute
  // http://localhost:3000, but lets a dev server on any port reach the
  // daemon same-origin (set VITE_API_URL to the dev origin) — the daemon's
  // CORS allowlist only covers port 5173.
  server: {
    // Plan imports the canonical applier/scheme modules from ../../core (see
    // dingoBasemap.ts). The monorepo root has no `workspaces` field, so vite's
    // workspace detection stops at apps/plan and would block those /@fs/
    // reads — allow the repo root explicitly (dev-server only; the build
    // bundles them like any other import).
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        fileURLToPath(new URL('../..', import.meta.url)),
      ],
    },
    proxy: {
      '/api': 'http://localhost:3000',
      '/photos': 'http://localhost:3000',
    },
  },
})
