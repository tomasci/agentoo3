// API process. The worker runs separately (src/worker.ts) because Claude
// sessions outlive any HTTP request.

import { createApp } from '@/app'
import { env, hasClaudeCredential } from '@/env'
import { editorWebSocketHandler } from '@/features/editor/proxy'
import { logger } from '@/lib/logger'

const app = createApp()

if (!hasClaudeCredential) {
  logger.warn('No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set — agents cannot run yet.')
}

const server = Bun.serve({
  hostname: env.BACKEND_HOST,
  port: env.BACKEND_PORT,
  fetch: app.fetch,
  // Agent output streams for minutes; do not let Bun time the request out.
  idleTimeout: 255,
  // The editor proxy's own WebSocket half (features/editor/proxy.ts) — Bun
  // requires this at the server level, not per-request: `server.upgrade()`
  // inside `app.fetch` only works because this is the same `Bun.serve` call.
  websocket: editorWebSocketHandler,
})

logger.success(`API listening on http://${server.hostname}:${server.port}`)
logger.info(`OpenAPI at http://${server.hostname}:${server.port}/api/openapi.json`)
