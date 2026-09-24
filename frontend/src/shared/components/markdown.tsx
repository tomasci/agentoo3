import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/shared/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'

/**
 * One `components` map, hand-written rather than pulled in from
 * @tailwindcss/typography — that plugin styles a `.prose` wrapper globally,
 * which is at odds with "shadcn semantic colours only, no new CSS": every
 * element here is styled with Tailwind utilities instead, and the GFM table
 * goes through `ui/table` so it looks like every other table in the app.
 *
 * `node` is react-markdown's mdast node, not a DOM attribute — spreading it
 * through renders node="[object Object]" on the tag, so every override
 * destructures and drops it.
 */
const components: Components = {
  // External to the app, and a transcript should not be able to navigate the
  // session away from itself.
  a: ({ children, node: _node, className, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'font-medium text-primary underline underline-offset-4 hover:no-underline',
        className,
      )}
    >
      {children}
    </a>
  ),
  h1: ({ children, node: _node, className, ...props }) => (
    <h1 {...props} className={cn('text-xl font-semibold', className)}>
      {children}
    </h1>
  ),
  h2: ({ children, node: _node, className, ...props }) => (
    <h2 {...props} className={cn('text-lg font-semibold', className)}>
      {children}
    </h2>
  ),
  h3: ({ children, node: _node, className, ...props }) => (
    <h3 {...props} className={cn('text-base font-semibold', className)}>
      {children}
    </h3>
  ),
  h4: ({ children, node: _node, className, ...props }) => (
    <h4 {...props} className={cn('text-base font-semibold', className)}>
      {children}
    </h4>
  ),
  h5: ({ children, node: _node, className, ...props }) => (
    <h5 {...props} className={cn('text-base font-semibold', className)}>
      {children}
    </h5>
  ),
  h6: ({ children, node: _node, className, ...props }) => (
    <h6 {...props} className={cn('text-base font-semibold', className)}>
      {children}
    </h6>
  ),
  p: ({ children, node: _node, className, ...props }) => (
    <p {...props} className={cn('mb-3 leading-relaxed', className)}>
      {children}
    </p>
  ),
  ul: ({ children, node: _node, className, ...props }) => (
    <ul {...props} className={cn('mb-3 list-disc pl-5', className)}>
      {children}
    </ul>
  ),
  ol: ({ children, node: _node, className, ...props }) => (
    <ol {...props} className={cn('mb-3 list-decimal pl-5', className)}>
      {children}
    </ol>
  ),
  li: ({ children, node: _node, className, ...props }) => (
    <li {...props} className={cn('my-0.5', className)}>
      {children}
    </li>
  ),
  blockquote: ({ children, node: _node, className, ...props }) => (
    <blockquote
      {...props}
      className={cn('mb-3 border-l-2 border-border pl-3 text-muted-foreground', className)}
    >
      {children}
    </blockquote>
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr {...props} className={cn('my-5 border-border', className)} />
  ),
  // Inline code. `pre`'s own override resets these classes on a fenced
  // block's nested `code`, the same cascade trick the old CSS module used.
  code: ({ children, node: _node, className, ...props }) => (
    <code
      {...props}
      className={cn('rounded border bg-muted px-1.5 py-0.5 font-mono text-sm', className)}
    >
      {children}
    </code>
  ),
  pre: ({ children, node: _node, className, ...props }) => (
    <pre
      {...props}
      className={cn(
        'mb-3 max-h-[30rem] overflow-x-auto rounded-md border bg-muted p-3 font-mono text-sm leading-relaxed [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0',
        className,
      )}
    >
      {children}
    </pre>
  ),
  // Wrap wide tables rather than letting them push the page sideways, and
  // route the rest of the GFM table through the same parts every other table
  // in the app uses.
  table: ({ children, node: _node, ...props }) => (
    <div className="mb-3 overflow-x-auto">
      <Table {...props}>{children}</Table>
    </div>
  ),
  thead: ({ children, node: _node, ...props }) => <TableHeader {...props}>{children}</TableHeader>,
  tbody: ({ children, node: _node, ...props }) => <TableBody {...props}>{children}</TableBody>,
  tr: ({ children, node: _node, ...props }) => <TableRow {...props}>{children}</TableRow>,
  th: ({ children, node: _node, className, ...props }) => (
    <TableHead {...props} className={cn('whitespace-normal', className)}>
      {children}
    </TableHead>
  ),
  td: ({ children, node: _node, className, ...props }) => (
    <TableCell {...props} className={cn('whitespace-normal', className)}>
      {children}
    </TableCell>
  ),
  img: ({ node: _node, className, ...props }) => (
    // biome-ignore lint/a11y/useAltText: `alt` comes through `...props` from the markdown source (`![alt](src)`); this only adds layout classes.
    <img {...props} className={cn('h-auto max-w-full rounded-md', className)} />
  ),
}

/**
 * Agent output is markdown — headings, tables, fenced code — and was being
 * shown as plain text, so a reply came out as a wall of `#` and `|`.
 *
 * react-markdown does not render raw HTML unless a plugin is added to allow
 * it, which is the property that matters here: the text comes from a model
 * and from files in the repository, so it is not something to hand to
 * `innerHTML`. remark-gfm adds the parts of GitHub's dialect that actually
 * show up in this output — tables above all, plus task lists and
 * strikethrough.
 */
export function Markdown({ children, compact = false }: { children: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        compact ? 'text-sm' : 'text-base',
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
