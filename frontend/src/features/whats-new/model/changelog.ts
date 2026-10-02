import { parseChangelog } from './changelog.schema'

// __CHANGELOG__ only exists once esbuild's `define` (vite.config.ts) has
// substituted it for the releases merged from CHANGELOG.md + CHANGELOG.ru.md
// at the repo root — true for both `vite dev` and `vite build`, but not for
// `bun test`, which runs this file unbundled. `typeof` is the one operator
// JS lets you apply to an undeclared identifier without throwing, so the
// fallback (`[]`) only ever executes in that case — tests/setup.ts sets
// `globalThis.__CHANGELOG__` itself, from the same two files run through the
// same parser (model/changelog-markdown.ts), so a real test run never
// actually falls back to it. Mirrors shared/config/env.ts's own `typeof`
// guard on __APP_VERSION__, for the same reason.
const rawReleases = typeof __CHANGELOG__ !== 'undefined' ? __CHANGELOG__ : []

/** Every release, parsed and sorted newest-first, once at module load — this
 *  repo's "validate at the boundary, fail loudly" rule applied to content a
 *  future change could still hand-edit into the wrong shape (CHANGELOG.md /
 *  CHANGELOG.ru.md are markdown, not a schema, so nothing stops a typo'd kind
 *  from reaching here on its own). */
export const releases = parseChangelog({ releases: rawReleases })
