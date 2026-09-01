import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { logger as httpLogger } from 'hono/logger'
import { env } from '@/env'
import { healthRouter } from '@/features/health/routes'
import { libraryRouter } from '@/features/library/routes'
import { projectsRouter } from '@/features/projects/routes'
import { AppError } from '@/lib/errors'
import { logger } from '@/lib/logger'

export function createApp() {
  const app = new OpenAPIHono({
    // Return the field-level detail instead of a bare 400.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: 'Validation failed',
            issues: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        )
      }
    },
  })

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
  app.route('/api', libraryRouter)

  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'agentoo', version: '0.1.0' },
  })

  app.onError((error, c) => {
    if (error instanceof AppError) {
      logger.warn(`${error.status} ${error.message}`)
      return c.json(
        {
          error: error.message,
          ...(error.recoveryCommands && { recoveryCommands: error.recoveryCommands }),
        },
        error.status as 400,
      )
    }
    logger.error(error)
    return c.json({ error: 'Internal server error' }, 500)
  })

  app.notFound((c) => c.json({ error: 'Not found' }, 404))

  return app
}
