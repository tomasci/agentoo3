import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger as httpLogger } from 'hono/logger'
import { env } from '@/env'
import { attachmentsRouter } from '@/features/attachments/routes'
import { dockerRouter } from '@/features/docker/routes'
import { editorProxyRouter } from '@/features/editor/proxy'
import { editorRouter } from '@/features/editor/routes'
import { envFilesRouter } from '@/features/env-files/routes'
import { healthRouter } from '@/features/health/routes'
import { ideasRouter } from '@/features/ideas/routes'
import { learningRouter } from '@/features/learning/routes'
import { libraryRouter } from '@/features/library/routes'
import { notificationsRouter } from '@/features/notifications/routes'
import { projectsRouter } from '@/features/projects/routes'
import { sessionsRouter } from '@/features/sessions/routes'
import { sourcesRouter } from '@/features/sources/routes'
import { sshKeysRouter } from '@/features/ssh-keys/routes'
import { systemRouter } from '@/features/system/routes'
import { whatsNewRouter } from '@/features/whats-new/routes'
import { AppError, errorBody } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { openApiValidationHook } from '@/lib/openapi-hook'

export function createApp() {
  const app = new OpenAPIHono({ defaultHook: openApiValidationHook })

  app.use(
    '*',
    httpLogger((message) => logger.debug(message)),
  )
  // Cross-origin access is off unless explicitly configured, and that costs
  // nothing: nginx serves the frontend and /api/ from one origin in production,
  // and the Vite dev server proxies /api, so both are already same-origin.
  //
  // Reflecting the request origin here would have been a real hole. There is no
  // app-level auth by design, so any page a browser on the tailnet visited could
  // have read this API's responses and driven its endpoints — including POST
  // /api/projects, whose remoteUrl reaches `git clone`.
  if (env.CORS_ORIGINS.length > 0) {
    logger.info(`CORS enabled for: ${env.CORS_ORIGINS.join(', ')}`)
    app.use(
      '/api/*',
      cors({
        origin: env.CORS_ORIGINS,
        // No cookie or credential auth exists, so nothing needs sending.
        credentials: false,
      }),
    )
  }

  app.route('/api', healthRouter)
  app.route('/api', projectsRouter)
  app.route('/api', envFilesRouter)
  app.route('/api', libraryRouter)
  app.route('/api', learningRouter)
  app.route('/api', sshKeysRouter)
  app.route('/api', sourcesRouter)
  app.route('/api', sessionsRouter)
  app.route('/api', attachmentsRouter)
  app.route('/api', dockerRouter)
  app.route('/api', editorRouter)
  app.route('/api', editorProxyRouter)
  app.route('/api', ideasRouter)
  app.route('/api', systemRouter)
  app.route('/api', whatsNewRouter)
  app.route('/api', notificationsRouter)

  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'agentoo', version: '0.1.0' },
  })

  app.onError((error, c) => {
    if (error instanceof AppError) {
      logger.warn(`${error.status} ${error.message}`)
      return c.json(errorBody(error), error.status as 400)
    }
    // Hono's own request parsing throws this before any route handler (or its
    // OpenAPI schema's own `openApiValidationHook`) ever runs — a malformed
    // JSON body, chiefly (see hono's validator.ts) — so it never reaches here
    // as an AppError, and previously fell through to the generic 500 below
    // for what is, from a caller's point of view, exactly the same kind of
    // 400 this API returns everywhere else. Nothing in this codebase throws
    // an HTTPException itself (grep confirms it), so every instance reaching
    // this point came from Hono/its middleware, not from a handler that
    // chose 500 and would be surprised to see it become one.
    if (error instanceof HTTPException) {
      if (error.status >= 500) {
        logger.error(error)
      } else {
        logger.warn(`${error.status} ${error.message}`)
      }
      return c.json({ error: error.message || 'Request failed' }, error.status)
    }
    logger.error(error)
    return c.json({ error: 'Internal server error' }, 500)
  })

  app.notFound((c) => c.json({ error: 'Not found' }, 404))

  return app
}
