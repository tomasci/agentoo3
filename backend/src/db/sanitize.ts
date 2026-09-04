// Postgres cannot store the Unicode NUL character (code point zero) in a text
// column, and jsonb cannot represent it inside a string value either — it
// raises "unsupported Unicode escape sequence" and rejects the whole row.
//
// Tool output is untrusted, near-binary data rather than text we chose. A
// headless browser's stderr arrived full of HarfBuzz diagnostics carrying that
// character, and every message of that turn failed to insert. Because
// appendMessage persists before it publishes, a rejected row is lost twice:
// never stored, and never streamed to a connected client either.
//
// The character is built with fromCharCode rather than written as a literal or
// an escape for exactly the same reason it has to be stripped: source code and
// comments get recorded as tool output by the agents working on this repo, and
// spelling it out reproduces the bug in whatever records this file.
const NUL = String.fromCharCode(0)

/**
 * A plain, JSON-derived container, as opposed to a Date, a Drizzle SQL
 * fragment, a Buffer, or any other class instance. Guessing at the internals
 * of another class would corrupt it rather than clean it.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sanitizeString(value: string): string {
  // The guard that keeps the common case free. This runs on every message of
  // every turn and almost none carry a NUL, so the fast path must scan once
  // and allocate nothing rather than rebuild every string unconditionally.
  return value.includes(NUL) ? value.replaceAll(NUL, '') : value
}

function sanitizeArray(value: unknown[]): unknown[] {
  let changed = false
  const next = value.map((item) => {
    const clean = sanitize(item)
    if (clean !== item) changed = true
    return clean
  })
  return changed ? next : value
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // Keys carry it as readily as values: a key derived from tool output is
    // built the same way a value is.
    const cleanKey = sanitizeString(key)
    const cleanItem = sanitize(item)
    if (cleanKey !== key || cleanItem !== item) changed = true
    next[cleanKey] = cleanItem
  }
  return changed ? next : value
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value !== 'object') return value
  // Drizzle passes real Date instances for timestamp columns; walking one as a
  // plain object hands back an empty object and breaks every insert that sets
  // updatedAt.
  if (value instanceof Date) return value
  if (Array.isArray(value)) return sanitizeArray(value)
  if (isPlainObject(value)) return sanitizeObject(value)
  // A Drizzle SQL fragment, a Buffer, or another class instance this process
  // did not build from JSON. Not ours to walk.
  return value
}

/**
 * Recursively strip the NUL character from every string reachable from `value`
 * — object keys as well as values, at any depth — returning the same reference
 * when there was nothing to strip.
 *
 * Only NUL is removed. Newlines, tabs and ANSI colour escapes are legitimate
 * and often load-bearing in tool output; a sanitizer that ate those to be safe
 * would corrupt more transcripts than the bug it was written to fix.
 *
 * Accepts a bare string too, for text columns fed from the same untrusted
 * sources outside a jsonb payload: messages.title, and the lastError fields
 * that usually hold a process's stderr verbatim.
 *
 * No cycle detection. Every input here is JSON-derived — parsed off the wire or
 * built from object literals around one — so a reference cycle cannot occur.
 */
export function sanitizeForDb<T>(value: T): T {
  return sanitize(value) as T
}
