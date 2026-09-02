import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/shared/ui/markdown'

const html = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>)

test('headings, emphasis and inline code render as elements', () => {
  const out = html('# agentoo\n\nA **self-hosted** platform using `curl`.')
  expect(out).toContain('<h1>agentoo</h1>')
  expect(out).toContain('<strong>self-hosted</strong>')
  expect(out).toContain('<code>curl</code>')
})

test('gfm tables render as a table', () => {
  // The reported case: the reply opened with a table and came out as raw pipes.
  const out = html('| Layer | What |\n|---|---|\n| API | Hono |')
  expect(out).toContain('<table>')
  expect(out).toContain('<th>Layer</th>')
  expect(out).toContain('<td>Hono</td>')
})

test("react-markdown's node prop never reaches the DOM", () => {
  // Spreading the props of a custom component forwards `node`, the mdast node,
  // which React then renders as node="[object Object]" on the tag.
  expect(html('| A |\n|---|\n| 1 |')).not.toContain('node=')
  expect(html('[docs](https://example.com)')).not.toContain('node=')
})

test('fenced code keeps its content verbatim', () => {
  const out = html('```sh\ncurl -fsSL https://x | sudo bash\n```')
  expect(out).toContain('<pre>')
  expect(out).toContain('curl -fsSL https://x | sudo bash')
})

test('lists render', () => {
  const out = html('- one\n- two\n')
  expect(out).toContain('<ul>')
  expect(out).toContain('<li>one</li>')
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
