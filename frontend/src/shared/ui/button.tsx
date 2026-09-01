import { ark } from '@ark-ui/react'
import type { ComponentPropsWithoutRef } from 'react'
import styles from './button.module.scss'

type ButtonProps = ComponentPropsWithoutRef<typeof ark.button>

// Ark's factory keeps the polymorphic `asChild` behaviour while letting us own
// the styling; Ark ships no CSS of its own.
export function Button({ className, ...props }: ButtonProps) {
  return <ark.button className={[styles.button, className].filter(Boolean).join(' ')} {...props} />
}
