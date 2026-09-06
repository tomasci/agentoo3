import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import versionJson from '../version.json' with { type: 'json' }

// The one composed string, not the {major, minor, build} object — matches
// what bump-build.ts writes into the two package.json files, and what the
// backend's GET /api/health reports (backend/src/lib/version.ts).
const appVersion = `${versionJson.major}.${versionJson.minor}.${versionJson.build}`

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  css: {
    modules: {
      // Readable in devtools, hashed enough to stay unique.
      generateScopedName: '[name]__[local]___[hash:base64:5]',
    },
  },
  define: {
    // Baked into the bundle at build time, so a tab never has to ask the
    // server what it itself is running. env.ts reads it back as
    // `env.appVersion` to compare against the backend's own version and catch
    // a tab stuck on yesterday's JS (see version-skew.ts) — server.ts serves
    // index.html `no-cache` but /assets/ `immutable`, so a tab left open and
    // never navigated never re-fetches either on its own.
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    host: process.env.FRONTEND_HOST ?? '127.0.0.1',
    port: Number(process.env.FRONTEND_PORT ?? 3000),
    // The backend is behind nginx in production; mirror that in dev.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.BACKEND_PORT ?? 8000}`,
        changeOrigin: true,
      },
    },
  },
})
