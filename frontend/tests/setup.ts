import { plugin } from 'bun'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// React's `act` only exists in its development build, and only runs when the
// environment declares itself a test one. Set before anything imports React —
// and set unconditionally, because this host runs with NODE_ENV=production,
// under which React's entry point exports no `act` at all.
process.env.NODE_ENV = 'development'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A DOM, so the shell can be mounted and clicked rather than only rendered to a
// string: the tab rules live in effects, and effects do not run in SSR.
//
// `navigation.disableChildFrameNavigation` — features/editor's dashboard used
// to be this app's first real `<iframe src>` (it opens the whole editor as
// its own browser tab now, with no iframe left anywhere in the app — see
// editor-launcher.tsx), and without this happy-dom actually tries to fetch
// and navigate a rendered one, firing real requests against whatever is
// listening on localhost (or hanging waiting for one) from every test that
// happens to render one, not just that feature's own. Left in place as a
// guard for whichever feature adds the next one.
GlobalRegistrator.register({
  url: 'http://localhost/',
  settings: { navigation: { disableChildFrameNavigation: true } },
})

// TanStack Router ships a per-runtime `isServer`, and its export map answers
// the "bun" condition with the *server* build. That build skips `Transitioner`,
// the component that initialises the router for a live DOM, so the first layout
// effect throws on `router._rendered`. A bare specifier cannot be re-pointed
// from a runtime plugin, but the file it resolves to can be replaced with the
// browser's answer — which is what a real browser and Vite both get.
plugin({
  name: 'tanstack-isserver-browser',
  setup(build) {
    build.onLoad({ filter: /router-core[\\/]dist[\\/]esm[\\/]isServer[\\/]server\.js$/ }, () => ({
      contents: 'export const isServer = false\nexport const loadServerRoute = undefined\n',
      loader: 'js',
    }))
  },
})

// A dozen component test files (ui-core.test.tsx, docker-page.test.tsx,
// storage-page.test.tsx, editor-page.test.tsx, …) each carry their own copy of
// this exact `plugin()` call, targeting the same ten `shared/ui`
// `.module.scss` files — see any of those files' own "Same identity-proxy
// loader…" comment for why they need real class names rather than the bare
// string `bun test`'s default `.module.scss` loader hands back.
//
// Bun's module cache for a given specifier is process-wide and filled on
// FIRST load by whichever `onLoad` (if any) happens to be registered at that
// moment — so with a dozen files each racing to be the one whose own
// `plugin()` call runs first, the set of files sharing this process is itself
// part of the race. Verified empirically while adding this track's own
// editor-page.test.tsx: that one additional file was enough to flip it, and a
// run started surfacing failures in *other, unrelated* files (storage-page,
// transcript-*, ui-core itself) that touch nothing this track owns.
//
// Registered here instead, exactly like `tanstack-isserver-browser` above:
// `bunfig.toml`'s `[test] preload` runs this file before any test file's own
// imports, so the transform is active from the very first `.module.scss` load
// of the run, deterministically, regardless of which test file that is. Every
// file's own copy of this same plugin (left as-is — rewriting a dozen files is
// a separate, larger change than this track owns) becomes a harmless retry of
// an already-satisfied `onLoad`.
plugin({
  name: 'ui-core-styles-identity-proxy',
  setup(build) {
    build.onLoad(
      {
        filter:
          /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/,
      },
      () => ({
        contents:
          'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
        loader: 'js',
      }),
    )
  },
})
