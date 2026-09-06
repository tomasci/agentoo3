import type { ZodError } from 'zod'

/** One field-level complaint, in the shape a client already parses off any
 * other 400 this API returns. */
export type ValidationIssue = { path: string; message: string }

/** An error that carries a status code and, optionally, user-facing next steps
 * or the field-level detail behind a validation failure. */
export class AppError extends Error {
  readonly status: number
  readonly recoveryCommands?: string[]
  readonly issues?: ValidationIssue[]

  constructor(
    message: string,
    status = 500,
    extra?: { recoveryCommands?: string[]; issues?: ValidationIssue[] },
  ) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.recoveryCommands = extra?.recoveryCommands
    this.issues = extra?.issues
  }
}

export const notFound = (what: string) => new AppError(`${what} not found`, 404)
export const badRequest = (message: string) => new AppError(message, 400)
export const conflict = (message: string) => new AppError(message, 409)

/** A zod failure's issues, flattened to the shape this API puts on the wire —
 * shared so every 400 that started as a failed parse looks the same,
 * regardless of which validator caught it. */
export const issuesFor = (error: ZodError): ValidationIssue[] =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))

/**
 * A 400 in exactly the shape `app.ts`'s `defaultHook` builds for a route the
 * OpenAPI router validated itself.
 *
 * A route that lives outside that router (an SSE stream, a file download —
 * see sessions/routes.ts) never reaches `defaultHook`, but still takes a
 * client-supplied param or query it has to reject before touching the
 * database. Going through this rather than `badRequest` is what keeps that
 * rejection looking identical to every other one, instead of adding a second,
 * differently-shaped 400 to the API for no reason a caller could tell.
 */
export const validationFailed = (issues: ValidationIssue[]) =>
  new AppError('Validation failed', 400, { issues })

/** The JSON body for an AppError, wherever it is caught — `onError` in
 * `app.ts` for the normal case, and the same-shaped per-router handlers that
 * exist only so a router's own tests can see it without booting the whole
 * app (see `projectsRouter`/`sessionsRouter`). One function means those
 * cannot drift apart on which optional field they remember to forward. */
export const errorBody = (error: AppError) => ({
  error: error.message,
  ...(error.recoveryCommands && { recoveryCommands: error.recoveryCommands }),
  ...(error.issues && { issues: error.issues }),
})
