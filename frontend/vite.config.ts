import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import versionJson from '../version.json' with { type: 'json' }
import {
  mergeChangelogMarkdown,
  parseChangelogMarkdown,
} from './src/features/whats-new/model/changelog-markdown'

// The one composed string, not the {major, minor, build} object — matches
// what bump-build.ts writes into the two package.json files, and what the
// backend's GET /api/health reports (backend/src/lib/version.ts).
const appVersion = `${versionJson.major}.${versionJson.minor}.${versionJson.build}`

// The "What's new" changelog lives as Markdown at the repo root rather than
// JSON inside the feature, so it reads on GitHub (frontend/README.md's
// "Adding a changelog entry"). Read and parsed here, at config-*load* time
// (not inside a plugin hook), the same way version.json already is a few
// lines up — a relative import, resolved from this file's own URL, not from
// whatever directory `vite` happened to be invoked from. That also means a
// malformed changelog fails `vite build` / dev startup the same way a
// malformed version.json would, rather than reaching the browser as a blank
// screen or a half-rendered list.
const changelogEnPath = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))
const changelogRuPath = fileURLToPath(new URL('../CHANGELOG.ru.md', import.meta.url))
const changelogEn = parseChangelogMarkdown(
  readFileSync(changelogEnPath, 'utf8'),
  'en',
  'CHANGELOG.md',
)
const changelogRu = parseChangelogMarkdown(
  readFileSync(changelogRuPath, 'utf8'),
  'ru',
  'CHANGELOG.ru.md',
)
const changelog = mergeChangelogMarkdown(
  changelogEn,
  changelogRu,
  'CHANGELOG.md',
  'CHANGELOG.ru.md',
)

/**
 * `define` freezes __CHANGELOG__ at the moment this config file is loaded, so
 * editing either Markdown file while `vite dev` is already running would
 * otherwise show the old list until the next manual restart. Chokidar's
 * default watch root is the Vite project root (`frontend/`), which does not
 * cover `../CHANGELOG*.md` on its own, so both paths are added to the
 * watcher explicitly; `server.restart()` re-runs this whole module, which
 * re-reads and re-parses them the same way a cold `vite dev` would.
 */
function changelogReloadPlugin(paths: string[]): Plugin {
  return {
    name: 'whats-new-changelog-reload',
    configureServer(server) {
      for (const path of paths) server.watcher.add(path)
      server.watcher.on('change', (file) => {
        if (paths.includes(file)) server.restart()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), changelogReloadPlugin([changelogEnPath, changelogRuPath])],
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
    // See the comment above changelogEnPath: merged once, here, from the two
    // Markdown files — features/whats-new/model/changelog.ts reads it back
    // through the same zod schema the old hand-edited changelog.json was
    // validated with.
    __CHANGELOG__: JSON.stringify(changelog),
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
