// Split out of app.ts so it can be imported on its own — a test that wants to
// mount one router under a parent with the exact same validation behaviour
// createApp() gives every route (see api-error-envelope.test.ts) would
// otherwise have to import app.ts itself, which pulls in every feature
// router's own real dependencies along with it.
import type { OpenAPIHono } from '@hono/zod-openapi'
import { issuesFor } from './errors'

type DefaultHook = NonNullable<ConstructorParameters<typeof OpenAPIHono>[0]>['defaultHook']

/**
 * Return the field-level detail instead of a bare 400. issuesFor is the same
 * mapping `validationFailed` (errors.ts) uses for the handful of routes that
 * sit outside the OpenAPI router and validate their own params (see
 * sessions/routes.ts) — one shape for "your input didn't parse", however it
 * was caught.
 */
export const openApiValidationHook: DefaultHook = (result, c) => {
  if (!result.success) {
    return c.json({ error: 'Validation failed', issues: issuesFor(result.error) }, 400)
  }
}
