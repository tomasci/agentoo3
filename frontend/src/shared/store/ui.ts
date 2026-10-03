import { atomWithStorage, createJSONStorage } from 'jotai/utils'

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

// Every id a background colour, a gradient or a pattern can be. Declared
// here rather than in features/appearance because the two persisted atoms
// below need the full id union for their own type — features/appearance's
// catalog (lib/catalog.ts) imports these same tuples rather than
// re-declaring its own copy, so there is exactly one list of valid ids for
// both the storage boundary below and the feature that renders them.
export const BACKGROUND_COLOR_IDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'mint',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'purple',
  'pink',
  'brown',
] as const
export const BACKGROUND_GRADIENT_IDS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const
export const BACKGROUND_PATTERN_IDS = [
  'code',
  'space',
  'nature',
  'weather',
  'doodles',
  'geometric',
] as const

export type BackgroundColorId = (typeof BACKGROUND_COLOR_IDS)[number]
export type BackgroundGradientId = (typeof BACKGROUND_GRADIENT_IDS)[number]
export type BackgroundId = 'none' | BackgroundColorId | BackgroundGradientId
export type BackgroundPatternId = (typeof BACKGROUND_PATTERN_IDS)[number]
export type BackgroundPatternValue = 'none' | BackgroundPatternId

const KNOWN_BACKGROUND_IDS = new Set<string>([
  'none',
  ...BACKGROUND_COLOR_IDS,
  ...BACKGROUND_GRADIENT_IDS,
])
const KNOWN_BACKGROUND_PATTERN_VALUES = new Set<string>(['none', ...BACKGROUND_PATTERN_IDS])

/**
 * Wraps jotai's own `createJSONStorage` so a stored value is checked against
 * a known-id set on the way in, not just parsed as JSON — unlike
 * `composerModeAtom` above, where a bad value is left for every reader to
 * normalize itself (`mode === 'raw' ? … : …`), a background or pattern id
 * indexes straight into features/appearance's catalog of Tailwind classes,
 * and doing that with an unrecognised string would be a silent no-op at
 * best. Validating once here means `backgroundAtom`/`backgroundPatternAtom`
 * can never hold anything but a real id — garbage, an old value from a
 * removed id, or a non-string all read as `fallback`, and nothing here ever
 * throws. `getItem` and `subscribe` (the one other place a raw value reaches
 * a reader, when a *different* tab writes to the same key) both go through
 * the same `validate`.
 */
function validatedStorage<Value extends string>(
  isKnown: (value: unknown) => value is Value,
  fallback: Value,
) {
  const base = createJSONStorage<Value>()
  const validate = (value: unknown): Value => (isKnown(value) ? value : fallback)
  return {
    ...base,
    getItem: (key: string, initialValue: Value) => validate(base.getItem(key, initialValue)),
    subscribe: base.subscribe
      ? (key: string, callback: (value: Value) => void, initialValue: Value) =>
          base.subscribe?.(key, (value) => callback(validate(value)), initialValue)
      : undefined,
  }
}

function isBackgroundId(value: unknown): value is BackgroundId {
  return typeof value === 'string' && KNOWN_BACKGROUND_IDS.has(value)
}

function isBackgroundPatternValue(value: unknown): value is BackgroundPatternValue {
  return typeof value === 'string' && KNOWN_BACKGROUND_PATTERN_VALUES.has(value)
}

// Persisted per browser, same `getOnInit` rationale as `composerModeAtom`
// above: without it, the default shell would flash before this reader's
// chosen backdrop painted in on top of it. `'none'` renders nothing at all
// (features/appearance's `BackgroundBackdrop`) — today's plain shell is the
// default, not one option among many.
export const backgroundAtom = atomWithStorage<BackgroundId>(
  'agentoo:background',
  'none',
  validatedStorage(isBackgroundId, 'none'),
  { getOnInit: true },
)

// Independent of `backgroundAtom`: a pattern drawn over `'none'` is a valid
// choice (texture on top of the shell's ordinary surface), so this is its
// own key rather than a field folded into the background one.
export const backgroundPatternAtom = atomWithStorage<BackgroundPatternValue>(
  'agentoo:background-pattern',
  'none',
  validatedStorage(isBackgroundPatternValue, 'none'),
  { getOnInit: true },
)

// The reader's chosen accent colour — the same 18 ids as the background,
// since both pick from one catalog (features/appearance's lib/catalog.ts),
// but its own type alias and its own key: unlike the background, this colours
// buttons/links/checked controls, and the user is expected to pick it
// independently of the background (matching it is their choice, not a rule
// this app enforces), so the two atoms never read off one another.
export type AccentColorId = BackgroundId
export const accentColorAtom = atomWithStorage<AccentColorId>(
  'agentoo:accent-color',
  'none',
  validatedStorage(isBackgroundId, 'none'),
  { getOnInit: true },
)

/** Whether either persisted choice above is anything but the default — the
 * one fact root-layout.tsx and sidebar.tsx both need to decide whether the
 * sidebar should give up its own opaque surface and the page body should turn
 * to glass, so it lives next to the atoms it reads rather than being worked
 * out twice. */
export function isBackgroundActive(
  background: BackgroundId,
  pattern: BackgroundPatternValue,
): boolean {
  return background !== 'none' || pattern !== 'none'
}
