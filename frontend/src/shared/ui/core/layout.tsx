import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './layout.module.scss'

type Gap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const GAP: Record<Gap, string> = {
  0: styles.gap0 as string,
  1: styles.gap1 as string,
  2: styles.gap2 as string,
  3: styles.gap3 as string,
  4: styles.gap4 as string,
  5: styles.gap5 as string,
  6: styles.gap6 as string,
  8: styles.gap8 as string,
}

type StackAlign = 'start' | 'center' | 'end' | 'stretch'
const STACK_ALIGN: Record<StackAlign, string> = {
  start: styles.alignStart as string,
  center: styles.alignCenter as string,
  end: styles.alignEnd as string,
  stretch: styles.alignStretch as string,
}

type InlineAlign = 'start' | 'center' | 'end' | 'baseline'
const INLINE_ALIGN: Record<InlineAlign, string> = {
  start: styles.alignStart as string,
  center: styles.alignCenter as string,
  end: styles.alignEnd as string,
  baseline: styles.alignBaseline as string,
}

type Justify = 'start' | 'center' | 'end' | 'between'
const JUSTIFY: Record<Justify, string> = {
  start: styles.justifyStart as string,
  center: styles.justifyCenter as string,
  end: styles.justifyEnd as string,
  between: styles.justifyBetween as string,
}

interface StackProps {
  gap?: Gap
  align?: StackAlign
  children: ReactNode
}

interface InlineProps {
  gap?: Gap
  align?: InlineAlign
  justify?: Justify
  wrap?: boolean
  children: ReactNode
}

/**
 * The sanctioned escape hatch for spacing (component-contract.md). A
 * component never carries its own outer margin — spacing between things is
 * the parent's job, which is why 9 inline `style={{ marginTop }}` leaks
 * existed before this: no component owned the gap.
 */
export function Stack({ gap = 3, align = 'stretch', children }: StackProps) {
  return <div className={cx(styles.stack, GAP[gap], STACK_ALIGN[align])}>{children}</div>
}

export function Inline({
  gap = 2,
  align = 'center',
  justify = 'start',
  wrap = true,
  children,
}: InlineProps) {
  return (
    <div
      className={cx(
        styles.inline,
        GAP[gap],
        INLINE_ALIGN[align],
        JUSTIFY[justify],
        wrap ? styles.wrap : styles.noWrap,
      )}
    >
      {children}
    </div>
  )
}
