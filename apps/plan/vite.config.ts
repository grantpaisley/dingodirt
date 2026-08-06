import { defineConfig } from 'vite'
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
})
