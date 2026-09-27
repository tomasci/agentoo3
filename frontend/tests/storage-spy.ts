/** Swaps `globalThis.localStorage` for a thin wrapper around the real one,
 *  for recording (or failing) the writes code under test makes.
 *
 *  Patching `Storage.prototype.setItem` looks like the obvious spy and is not
 *  one here: under happy-dom on bun, once `localStorage.setItem` has been
 *  called at all in the process, later prototype patches are never reached
 *  — verified with a probe that called it once, patched, called it again and
 *  recorded nothing. Replacing the global itself is reached by every
 *  `localStorage.…` lookup in src/, whenever it runs.
 *
 *  `overrides` replace individual methods (to make one throw); `onWrite` sees
 *  every setItem/removeItem that reaches the real storage. Returns the undo —
 *  call it in `afterEach`/`finally`, it is idempotent. */
export interface StorageWrite {
  op: 'set' | 'remove'
  key: string
  value?: string
}

export function swapLocalStorage(
  opts: {
    onWrite?: (w: StorageWrite) => void
    overrides?: Partial<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>>
  } = {},
): () => void {
  const real = globalThis.localStorage
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const wrapper = {
    getItem: opts.overrides?.getItem ?? ((k: string) => real.getItem(k)),
    setItem:
      opts.overrides?.setItem ??
      ((k: string, v: string) => {
        opts.onWrite?.({ op: 'set', key: k, value: v })
        real.setItem(k, v)
      }),
    removeItem:
      opts.overrides?.removeItem ??
      ((k: string) => {
        opts.onWrite?.({ op: 'remove', key: k })
        real.removeItem(k)
      }),
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    get length() {
      return real.length
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: wrapper,
    configurable: true,
    writable: true,
  })
  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true, writable: true })
  }
}
