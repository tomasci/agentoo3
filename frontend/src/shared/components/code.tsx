import { cn } from '@/shared/lib/utils'

interface CodeProps {
  children: string
  block?: boolean
  wrap?: boolean
}

/**
 * `<code>` for an inline token, `<pre><code>` for a multi-line block. No
 * shadcn primitive covers this, so it's Tailwind's default mono stack plus
 * the semantic `muted`/`border` tokens rather than a one-off colour.
 */
export function Code({ children, block = false, wrap = false }: CodeProps) {
  if (block) {
    return (
      <pre
        className={cn(
          'max-h-[30rem] overflow-x-auto rounded-md border bg-muted p-3 font-mono text-sm leading-relaxed',
          wrap && 'whitespace-pre-wrap break-words',
        )}
      >
        <code>{children}</code>
      </pre>
    )
  }

  return (
    <code
      className={cn(
        'rounded border bg-muted px-1.5 py-0.5 font-mono text-sm',
        wrap && 'whitespace-pre-wrap break-words',
      )}
    >
      {children}
    </code>
  )
}
