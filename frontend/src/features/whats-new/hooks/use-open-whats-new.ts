import { useSetAtom } from 'jotai'
import { whatsNewOpenAtom } from '../model/open-state'

/**
 * What the status bar's version button calls to reopen the screen — the
 * only thing outside this feature allowed to touch open-state.ts's atom, so
 * it is exported from the barrel rather than the atom itself. Reopening is
 * always `'manual'`: it never fires a dismiss request on close, whether or
 * not some install is still pending one (see open-state.ts).
 */
export function useOpenWhatsNew(): () => void {
  const setMode = useSetAtom(whatsNewOpenAtom)
  return () => setMode('manual')
}
