import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { logger as httpLogger } from 'hono/logger'
import { hasClaudeCredential } from '@/env'
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
  // nginx serves the frontend from the same origin, so CORS is only needed for
  // the Vite dev server on another port.
  app.use('/api/*', cors({ origin: (origin) => origin ?? '*', credentials: true }))

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok' as const,
      version: process.env.npm_package_version ?? '0.1.0',
      // The frontend shows this: agents cannot run without a credential.
      claudeCredential: hasClaudeCredential,
    }),
  )

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
