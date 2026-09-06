// Content-sniffed MIME allowlist. Pure: takes the first bytes of a file and
// its name, decides a type or rejects — no filesystem, no network.
//
// Deliberately hand-rolled rather than a dependency: the allowlist is five
// magic numbers and a text/binary split, which is a poor trade for a package.
// It is also deliberately a *subset* of what the SDK's own Read tool already
// renders (png/jpg/jpeg/gif/webp as images, arbitrary UTF-8 text, PDF) — see
// runner-options.ts — which is what lets this feature skip building any kind
// of extraction pipeline: reject at upload instead of failing a Read later.

const HEAD_BYTES = 8192

export interface SniffResult {
  ok: boolean
  mimeType?: string
  reason?: string
}

function startsWith(head: Uint8Array, magic: number[]): boolean {
  if (head.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (head[i] !== magic[i]) return false
  }
  return true
}

/** "GIF87a" or "GIF89a". */
function isGif(head: Uint8Array): boolean {
  return (
    head.length >= 6 &&
    startsWith(head, [0x47, 0x49, 0x46, 0x38]) &&
    (head[4] === 0x37 || head[4] === 0x39) &&
    head[5] === 0x61
  )
}

/** RIFF....WEBP: "RIFF" at 0, "WEBP" at 8, four size bytes between. */
function isWebp(head: Uint8Array): boolean {
  return (
    head.length >= 12 &&
    startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

/** text/plain unless the extension picks a more specific subtype. */
function subtypeFor(ext: string, text: string): string {
  if (ext === '.json') {
    // A probe, not a gate: `head` may be a truncated prefix of a much larger
    // file, so a parse failure here just means "could not confirm", not
    // "malformed" — it falls back to the always-safe text/plain rather than
    // rejecting a legitimate JSON dump that happens to be bigger than 8KiB.
    try {
      JSON.parse(text)
      return 'application/json'
    } catch {
      return 'text/plain'
    }
  }
  if (ext === '.csv') return 'text/csv'
  if (ext === '.md') return 'text/markdown'
  if (ext === '.yaml' || ext === '.yml') return 'application/yaml'
  return 'text/plain'
}

/**
 * Extensions that promise a specific binary format, mapped to the one sniffed
 * type that satisfies the promise. Deliberately narrow: this is not "trust
 * the extension" creeping back in, it is the one case where content-wins has
 * no legitimate exception — there is no honest reason for a `.png` to be
 * anything but PNG bytes, whereas a `.log` that happens to be a PDF is just a
 * misnamed file and stays welcome (see sniffContent below, unchanged for
 * every extension not in this map).
 */
const PROMISED_BINARY_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

/** The sniff itself: magic numbers, then a hard text/binary split, then the
 * extension only to pick *which* text subtype. Never compares its own result
 * against the extension — that is `sniff()`'s job, layered on top, so this
 * stays the one place "what does the content actually look like" is decided. */
function sniffContent(head: Uint8Array, filename: string): SniffResult {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ok: true, mimeType: 'image/png' }
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { ok: true, mimeType: 'image/jpeg' }
  if (isGif(head)) return { ok: true, mimeType: 'image/gif' }
  if (isWebp(head)) return { ok: true, mimeType: 'image/webp' }
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    return { ok: true, mimeType: 'application/pdf' }

  // No magic number matched. From here it is either text we can label, or
  // binary we do not have an allowlisted format for — and binary with no
  // magic match is rejected outright, which is what keeps an executable or an
  // archive out without needing a denylist of formats to keep current.
  if (head.includes(0)) {
    return { ok: false, reason: 'Contains a NUL byte partway through, so this is binary content' }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(head)
  } catch {
    return { ok: false, reason: 'Not valid UTF-8 and no recognised binary format' }
  }

  return { ok: true, mimeType: subtypeFor(extensionOf(filename), text) }
}

/**
 * Decide a file's MIME type from its first `HEAD_BYTES` and its filename, or
 * reject it. Never trusts a client-declared content type or the extension
 * alone — magic numbers first, then a hard text/binary split, and only then
 * the extension to pick *which* text subtype (all of that is `sniffContent`).
 *
 * On top of that: a `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.pdf` extension is a
 * promise about content, not just a label, and this is the one place that
 * promise is checked. A shell script named `screenshot.png` sniffs as valid
 * UTF-8 with no magic number and would otherwise be accepted and stored as
 * `text/plain` — misclassified as nothing in particular, but accepted, which
 * is enough to deceive both the UI and an agent reading the extension. Every
 * other extension keeps pure content-wins behaviour: a `.log` that is really
 * a PDF is still accepted and classified `application/pdf`.
 */
export function sniff(head: Uint8Array, filename: string): SniffResult {
  const result = sniffContent(head, filename)
  const promised = PROMISED_BINARY_TYPE[extensionOf(filename)]
  if (promised && (!result.ok || result.mimeType !== promised)) {
    const found =
      result.ok && result.mimeType ? result.mimeType : (result.reason ?? 'unrecognised content')
    return {
      ok: false,
      reason: `The extension "${extensionOf(filename)}" claims ${promised}, but the content sniffed as ${found}`,
    }
  }
  return result
}

export const SNIFF_HEAD_BYTES = HEAD_BYTES
