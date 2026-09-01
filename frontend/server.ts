// Production static server.
//
// `vite preview` is explicitly not meant for production, and nginx already
// fronts this, so the job here is only to serve dist/ correctly: real 404s for
// missing assets, SPA fallback for routes, and cache headers that let hashed
// assets be cached forever while index.html never is.

import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'

const DIST = resolve(import.meta.dir, 'dist')
const HOST = process.env.FRONTEND_HOST ?? '127.0.0.1'
const PORT = Number(process.env.FRONTEND_PORT ?? 3000)

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No build found at ${DIST}. Run \`bun run build\` first.`)
  process.exit(1)
}

const INDEX = join(DIST, 'index.html')

function cacheHeaders(path: string): Record<string, string> {
  // Vite fingerprints everything under /assets/, so those are safe to pin.
  if (path.startsWith('/assets/')) {
    return { 'cache-control': 'public, max-age=31536000, immutable' }
  }
  return { 'cache-control': 'no-cache' }
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    if (pathname.endsWith('/')) pathname += 'index.html'

    // Contain the resolved path inside dist/ — a request for /../../etc/passwd
    // must not escape the document root.
    const candidate = normalize(join(DIST, pathname))
    if (candidate !== DIST && !candidate.startsWith(DIST + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return new Response(Bun.file(candidate), { headers: cacheHeaders(pathname) })
    }

    // Anything else is a client-side route: hand back the shell.
    return new Response(Bun.file(INDEX), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  },
})

console.log(`agentoo frontend listening on http://${server.hostname}:${server.port}`)
