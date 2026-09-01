/**
 * Pull the message out of an API failure.
 *
 * The backend answers `{ error }` for an AppError and `{ error, issues[] }` for
 * a validation failure, and those messages are the useful part — "Remote URL may
 * not contain '::'" tells the reader what to fix, where "Request failed with
 * status code 400" does not.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: unknown } } | undefined)?.response?.data
  if (data && typeof data === 'object') {
    const body = data as { error?: unknown; issues?: { path?: string; message?: string }[] }
    if (Array.isArray(body.issues) && body.issues.length > 0) {
      return body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
    }
    if (typeof body.error === 'string') return body.error
  }
  return error instanceof Error ? error.message : fallback
}
