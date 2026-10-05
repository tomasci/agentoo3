import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '@/shared/components'

const html = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>)

test('headings, emphasis and inline code render as elements', () => {
  const out = html('# agentoo\n\nA **self-hosted** platform using `curl`.')
  expect(out).toMatch(/<h1[^>]*>agentoo<\/h1>/)
  expect(out).toContain('<strong>self-hosted</strong>')
  expect(out).toMatch(/<code[^>]*>curl<\/code>/)
})

test('gfm tables render through the shared table parts', () => {
  // The reported case: the reply opened with a table and came out as raw pipes.
  const out = html('| Layer | What |\n|---|---|\n| API | Hono |')
  expect(out).toContain('data-slot="table"')
  expect(out).toContain('data-slot="table-header"')
  expect(out).toContain('data-slot="table-row"')
  expect(out).toMatch(/<th[^>]*data-slot="table-head"[^>]*>Layer<\/th>/)
  expect(out).toMatch(/<td[^>]*data-slot="table-cell"[^>]*>Hono<\/td>/)
})

test("react-markdown's node prop never reaches the DOM", () => {
  // Spreading the props of a custom component forwards `node`, the mdast node,
  // which React then renders as node="[object Object]" on the tag.
  expect(html('| A |\n|---|\n| 1 |')).not.toContain('node=')
  expect(html('[docs](https://example.com)')).not.toContain('node=')
})

test('fenced code keeps its content verbatim, and resets the inline-code pill inside it', () => {
  const out = html('```sh\ncurl -fsSL https://x | sudo bash\n```')
  expect(out).toMatch(/<pre[^>]*>/)
  expect(out).toContain('curl -fsSL https://x | sudo bash')
  // The `pre` override strips the inline pill treatment off its nested `code`
  // (React HTML-escapes the `&` in the arbitrary-variant class name).
  expect(out).toContain('[&amp;_code]:border-0')
})

test('lists render', () => {
  const out = html('- one\n- two\n')
  expect(out).toMatch(/<ul[^>]*>/)
  expect(out).toMatch(/<li[^>]*>one<\/li>/)
})

test('raw HTML in the text is escaped, not rendered', () => {
  // The text comes from a model and from files in the repository, so this is
  // the property that matters: it is displayed, never executed. The escaped
  // output still contains the word "onerror" — as literal text, which is the
  // point — so the assertion is about tags, not substrings.
  const out = html('Hello <img src=x onerror="alert(1)"> <script>alert(2)</script>')
  expect(out).not.toMatch(/<img[\s>]/)
  expect(out).not.toMatch(/<script[\s>]/)
  expect(out).toContain('&lt;img')
  expect(out).toContain('&lt;script&gt;')
})

test('a genuine markdown image renders as an <img>, unlike escaped raw HTML above', () => {
  const out = html('![agentoo logo](https://example.com/logo.png)')
  expect(out).toMatch(/<img[^>]*src="https:\/\/example\.com\/logo\.png"/)
  expect(out).toMatch(/<img[^>]*alt="agentoo logo"/)
})

test('links open away from the app and cannot reach back into it', () => {
  const out = html('[docs](https://example.com)')
  expect(out).toContain('target="_blank"')
  expect(out).toContain('rel="noopener noreferrer"')
})

test('plain prose is unchanged', () => {
  expect(html("I'll have an agent investigate the project.")).toContain(
    "I&#x27;ll have an agent investigate the project.",
  )
})

test('compact shrinks the base text size without changing the markup shape', () => {
  const normal = html('Hello')
  const compact = renderToStaticMarkup(<Markdown compact>Hello</Markdown>)
  expect(normal).toContain('text-base')
  expect(compact).toContain('text-sm')
  expect(compact).not.toContain('text-base')
})

// --- wrapping: model output can carry a token with no break opportunity ------
//
// The reported case: a final reply ending in a bare GitHub "open a pull
// request" URL, rendered as a link, stuck out past the answer card on a phone
// and let the whole transcript pan sideways. happy-dom does no layout, so what
// is pinned here is the declaration the fix depends on, stated as "which
// overflow-wrap does this element actually inherit" — the nearest ancestor
// declaring one wins, so a later `wrap-normal` on a list item or a link would
// fail this just as surely as dropping the root's class.

const OPERATOR_REPLY =
  "I didn't open a pull request. GitHub's link for one is https://github.com/tomasci/agentoo3/pull/new/agentoo/s-f3e4bf18."
const LONG_PATH = `/srv/${'deeply-nested-directory/'.repeat(6)}file.ts`

const OVERFLOW_WRAP: Record<string, string> = {
  'wrap-anywhere': 'anywhere',
  'wrap-break-word': 'break-word',
  'wrap-normal': 'normal',
  // Tailwind's older spellings, which set the same property.
  'break-words': 'break-word',
  'break-normal': 'normal',
}

/** The overflow-wrap `el` ends up with: its own class, else the nearest
 *  ancestor's, else the initial value. */
function inheritedWrap(el: Element | null): string {
  for (let node = el; node; node = node.parentElement) {
    for (const cls of node.classList) {
      const value = OVERFLOW_WRAP[cls]
      if (value) return value
    }
  }
  return 'normal'
}

/** Parsed rather than matched as a string, so the tests below can walk the
 *  ancestor chain the way inheritance does. */
function dom(md: string, props: { compact?: boolean; breaks?: boolean } = {}) {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<Markdown {...props}>{md}</Markdown>)
  const root = host.firstElementChild
  if (!root) throw new Error('Markdown rendered nothing')
  return root
}

test('every variant of the markdown root wraps anywhere', () => {
  for (const props of [{}, { compact: true }, { breaks: true }, { compact: true, breaks: true }]) {
    expect({ props, cls: dom('hello', props).classList.contains('wrap-anywhere') }).toEqual({
      props,
      cls: true,
    })
  }
})

test("the operator's long URL link inherits wrap-anywhere, autolinked or written as a link", () => {
  for (const md of [
    OPERATOR_REPLY,
    `See [${'https://github.com/tomasci/agentoo3/pull/new/agentoo/s-f3e4bf18'}](https://github.com/tomasci/agentoo3/pull/new/agentoo/s-f3e4bf18).`,
  ]) {
    const link = dom(md).querySelector('a')
    if (!link) throw new Error(`no link rendered for ${md}`)
    expect(link.getAttribute('href')).toBe(
      'https://github.com/tomasci/agentoo3/pull/new/agentoo/s-f3e4bf18',
    )
    expect(inheritedWrap(link)).toBe('anywhere')
  }
})

test('inline code holding a long path inherits wrap-anywhere, in prose and in a list item', () => {
  const root = dom(`Edited \`${LONG_PATH}\`.\n\n- commit \`04b7ef0\` touched \`${LONG_PATH}\``)
  const codes = [...root.querySelectorAll('code')]
  expect(codes.map((c) => c.textContent)).toEqual([LONG_PATH, '04b7ef0', LONG_PATH])
  expect(codes.map(inheritedWrap)).toEqual(['anywhere', 'anywhere', 'anywhere'])
})

test('headings and blockquotes inherit it too, not just paragraphs', () => {
  const root = dom(`# ${LONG_PATH}\n\n> ${LONG_PATH}`)
  const heading = root.querySelector('h1')
  const quote = root.querySelector('blockquote')
  expect(inheritedWrap(heading)).toBe('anywhere')
  expect(inheritedWrap(quote)).toBe('anywhere')
})

test('the GFM table sits in a wrapper that scrolls itself and wraps cells only at word boundaries', () => {
  const root = dom('| name | url |\n| --- | --- |\n| agentoo | https://example.com/' + 'x'.repeat(120) + ' |')
  const table = root.querySelector('table')
  if (!table) throw new Error('no table rendered')
  // `ui/table`'s own `data-slot="table-container"` sits between the two, so
  // the wrapper is markdown.tsx's own div, found as the outermost ancestor
  // below the root rather than as `table.parentElement`.
  const wrapper = [...root.children].find((child) => child.contains(table))
  if (!wrapper) throw new Error('table is not under the markdown root')
  expect(wrapper.classList.contains('overflow-x-auto')).toBe(true)
  expect(wrapper.classList.contains('wrap-break-word')).toBe(true)
  // `anywhere` would let the auto table layout size every column to a single
  // character's width; every cell has to see `break-word` instead.
  const cells = [...table.querySelectorAll('th, td')]
  expect(cells.length).toBe(4)
  expect(cells.map(inheritedWrap)).toEqual(cells.map(() => 'break-word'))
})

test('fenced code is not where the root rule is relied on: it still scrolls inside its own pre', () => {
  // `white-space: pre` disables wrapping regardless of overflow-wrap, so the
  // fence's own `overflow-x-auto` is what keeps a long line in its box.
  const pre = dom(`\`\`\`\n${'x'.repeat(300)}\n\`\`\``).querySelector('pre')
  expect(pre?.classList.contains('overflow-x-auto')).toBe(true)
})
