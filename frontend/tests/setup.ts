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
GlobalRegistrator.register({ url: 'http://localhost/' })

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
