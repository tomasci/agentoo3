import { atomWithStorage } from 'jotai/utils'

// Persisted per browser, so a reload keeps the reader's choice.
export const themeAtom = atomWithStorage<'light' | 'dark'>('agentoo:theme', 'dark')

// Persisted per browser, same as the theme: a reader who tucks the sidebar
// away expects it to stay tucked away after a reload, not spring back open.
// Forced closed for the 'new' tab mode regardless of this value (root-layout.tsx)
// — that is a per-render decision, not a preference, so it is never written here.
export const sidebarOpenAtom = atomWithStorage('agentoo:sidebar-open', true)

// Persisted per browser, same as the theme and the sidebar. `getOnInit`
// reads localStorage synchronously at atom creation instead of the jotai
// default (start at the initial value, correct on the first effect after
// mount) — without it, a reader who left the composer in raw mode would
// briefly get a freshly-mounted `MarkdownEditor` on every page load before
// this atom's own effect tore it back down again, which is exactly the
// mount-then-destroy churn this option exists to avoid. Any stored value
// other than the literal string `'raw'` reads as `'visual'`, so a bad or
// pre-this-feature value in storage falls back to the default rather than
// failing closed.
export const composerModeAtom = atomWithStorage<'visual' | 'raw'>(
  'agentoo:composer-mode',
  'visual',
  undefined,
  { getOnInit: true },
)

// Persisted per browser, same rationale as `composerModeAtom` above —
// `getOnInit` avoids a `MarkdownField` in raw mode flashing visual on every
// page load before its own effect tears a freshly-mounted editor back down.
// Any stored value other than the literal string `'raw'` reads as `'visual'`.
// A separate key from `composerModeAtom`: a reader's taste for the session
// composer's compact box says nothing about a whole-document field, and the
// two must stay independently switchable.
export const documentEditorModeAtom = atomWithStorage<'visual' | 'raw'>(
  'agentoo:document-editor-mode',
  'visual',
  undefined,
  { getOnInit: true },
)
