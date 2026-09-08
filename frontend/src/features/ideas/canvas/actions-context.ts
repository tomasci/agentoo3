import { createContext, useContext } from 'react'
import type { IdeaBlock, IdeaGroup } from '../hooks/use-idea-canvas'

/**
 * The one callback a node genuinely cannot own itself: opening the shared
 * `BlockDialog`/`GroupDialog` that already lives in `idea-canvas.tsx`
 * (T11's, and the one place a kind-aware form and a rename field already
 * exist) rather than growing a second copy of either inside `canvas/**`.
 * Everything else a node does — patch its own position, delete itself,
 * leave a group — reaches for the same mutation hooks the ordered list
 * already uses (`hooks/use-idea-canvas.ts`) directly.
 *
 * A context, not a prop threaded through `data`: a custom node only receives
 * `NodeProps`, and `data` is this idea's own domain shape (`IdeaBlockNodeData`
 * /`IdeaGroupNodeData`) — not a place for callbacks that never change per
 * node and would otherwise have to be copied onto every one of them.
 */
export interface IdeaCanvasActions {
  onEditBlock: (block: IdeaBlock) => void
  onRenameGroup: (group: IdeaGroup) => void
  /** Grouped blocks need their owning group's own (x, y) to convert their
   * stored relative position back to absolute when the user removes them
   * from the group — see `block-node.tsx`'s `removeFromGroup`. */
  groupsById: Map<string, IdeaGroup>
}

const IdeaCanvasActionsContext = createContext<IdeaCanvasActions | null>(null)

export const IdeaCanvasActionsProvider = IdeaCanvasActionsContext.Provider

export function useIdeaCanvasActions(): IdeaCanvasActions {
  const value = useContext(IdeaCanvasActionsContext)
  if (!value) throw new Error('useIdeaCanvasActions used outside IdeaCanvasActionsProvider')
  return value
}
