import type { RefObject } from 'react'
import { createContext, useContext, useMemo, useState } from 'react'

export type PortalContainerRef = RefObject<HTMLElement | null>

/**
 * Non-strict, unlike `IdeaCanvasActionsContext`: `undefined` outside a
 * `Dialog` is not a caller mistake, it is the normal case (a `Select` in a
 * page, not a modal), and Ark's own `Portal` already treats a missing
 * `container` prop as "mount on `document.body`" — so returning `undefined`
 * here reaches that fallback for free instead of needing one of our own.
 */
const PortalContainerContext = createContext<PortalContainerRef | undefined>(undefined)

export const PortalContainerProvider = PortalContainerContext.Provider

/** The element a portalled popup should mount into. `undefined` outside a
    Dialog — which is exactly what Ark's Portal treats as "use document.body". */
export function usePortalContainer(): PortalContainerRef | undefined {
  return useContext(PortalContainerContext)
}

/**
 * Producer side, for whoever owns the container element — `Dialog.Content`
 * today.
 *
 * Deliberately not a plain `useRef`: Ark's `Portal` only re-reads
 * `props.container` inside a `useEffect` keyed on the **ref object's
 * identity** (`portal.js:10-15`), not on `.current`. A `useRef` happens to
 * work when the container node attaches before that effect runs — which is
 * the common case, since React attaches ref callbacks before running effects
 * — but correctness would then depend on that commit ordering: the moment the
 * container mounts in a *later* commit than the Portal's, a stable `useRef`
 * effect has already fired and will not fire again, and it fails by quietly
 * falling back to `document.body` rather than erroring — indistinguishable
 * from the unfixed bug. Holding the node in state and memoising a fresh
 * `{ current: node }` on it means the ref object itself changes when the node
 * arrives, so the effect re-fires regardless of ordering.
 */
export function usePortalHost(): {
  ref: (node: HTMLElement | null) => void
  container: PortalContainerRef
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const container = useMemo(() => ({ current: node }), [node])
  return { ref: setNode, container }
}
