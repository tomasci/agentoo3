import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import versionJson from '../version.json' with { type: 'json' }

// The one composed string, not the {major, minor, build} object — matches
// what bump-build.ts writes into the two package.json files, and what the
// backend's GET /api/health reports (backend/src/lib/version.ts).
const appVersion = `${versionJson.major}.${versionJson.minor}.${versionJson.build}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
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
        // BACKEND_PROXY_TARGET overrides the default so this also works
        // cross-container (see compose.yaml): 127.0.0.1 there is the
        // frontend's own container, not the backend's, so /api would 404
        // without an explicit target naming the backend's service.
        target:
          process.env.BACKEND_PROXY_TARGET ??
          `http://127.0.0.1:${process.env.BACKEND_PORT ?? 8000}`,
        changeOrigin: true,
        // The editor's own proxy (backend/src/features/editor/proxy.ts) needs
        // this dev server to carry a WebSocket upgrade through to /api too,
        // the same way nginx already does in production.
        ws: true,
        // `changeOrigin` above rewrites the outgoing Host to the backend's
        // own host:port, which is exactly what the editor proxy's origin
        // check (and, past it, code-server's own) must NOT see as the
        // browser's real host. Both events carry the *original* incoming
        // request, so its own Host header is still the browser's — restamped
        // here as X-Forwarded-Host before the request (or the upgrade)
        // leaves this process, on both the plain-HTTP and the WebSocket leg.
        configure: (proxy) => {
          const forwardIncomingHost = (
            proxyReq: { setHeader(name: string, value: string): void },
            req: { headers: { host?: string } },
          ) => {
            if (req.headers.host) proxyReq.setHeader('x-forwarded-host', req.headers.host)
          }
          proxy.on('proxyReq', forwardIncomingHost)
          proxy.on('proxyReqWs', forwardIncomingHost)
        },
      },
    },
  },
})
