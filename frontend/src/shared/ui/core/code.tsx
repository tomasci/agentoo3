import { cx } from '../lib/cx'
import styles from './code.module.scss'

interface CodeProps {
  children: string
  block?: boolean
  wrap?: boolean
}

/**
 * `<code>` for an inline token, `<pre><code>` for a multi-line block.
 * Replaces 17 scattered `font-family` declarations split across two
 * competing mono stacks — both now resolve to the single `--font-mono` here.
 */
export function Code({ children, block = false, wrap = false }: CodeProps) {
  if (block) {
    return (
      <pre className={cx(styles.block, wrap && styles.wrap)}>
        <code>{children}</code>
      </pre>
    )
  }

  return <code className={cx(styles.inline, wrap && styles.wrap)}>{children}</code>
}
