import { afterAll, mock } from 'bun:test'

/** `mock.module`, scoped to the file that calls it.
 *
 *  `mock.module` is process-wide and permanent: whatever it installs stays
 *  installed for every file `bun test` loads afterwards, so without an undo a
 *  file's fake becomes every later file's client. The obvious undo does not
 *  work. Saving the namespace from an `await import()` taken *before* the mock
 *  and handing it back in `afterAll` restores nothing, because `mock.module`
 *  mutates that namespace object in place — by the time `afterAll` runs, the
 *  saved "real" namespace holds the fake, and putting it back is a no-op.
 *
 *  Verified both ways, with a probe file placed after the mocking one and
 *  reading `fn.toString()`: with the namespace undo,
 *  tests/session-page-scroll.test.tsx's four clients and
 *  tests/storage-page.test.tsx's seven all escaped their files, closure state
 *  and all. With the plain-object copy below — which nothing can mutate,
 *  because it is no longer the module's own namespace — none of them do.
 *
 *  What gets snapshotted is whatever is live at the moment of the call: the
 *  real module, or another file's fake if one is somehow still installed.
 *  Restoring *that* rather than the real module is what keeps this helper from
 *  becoming the leak it exists to prevent.
 *
 *  Await it at module scope, before importing whatever is under test, the same
 *  way a bare `await mock.module(...)` had to be awaited there. The returned
 *  undo is registered as an `afterAll` for you; it is handed back as well for
 *  the caller that wants the real module back sooner than that. */
export async function mockModule<T extends object>(
  specifier: string,
  factory: () => T,
): Promise<() => void> {
  const live = { ...(await import(specifier)) }
  await mock.module(specifier, factory)
  const restore = () => {
    mock.module(specifier, () => live)
  }
  afterAll(restore)
  return restore
}
