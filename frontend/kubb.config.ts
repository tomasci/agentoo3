// OpenAPI -> typed models + zod schemas + react-query hooks.
//
// Deliberately not part of `bun run build`: there is no backend spec yet, so
// wiring it in would fail builds for no reason. Run `bun run codegen` once the
// backend serves an OpenAPI document.

import { adapterOas } from '@kubb/adapter-oas'
import { pluginReactQuery } from '@kubb/plugin-react-query'
import { pluginTs } from '@kubb/plugin-ts'
import { pluginZod } from '@kubb/plugin-zod'
import { defineConfig } from 'kubb'

export default defineConfig({
  root: '.',
  input: {
    // Point at the running backend, or swap for a checked-in openapi.json.
    path: process.env.OPENAPI_SPEC ?? 'http://127.0.0.1:8000/openapi.json',
  },
  output: {
    path: './src/shared/api/generated',
    clean: true,
  },
  // In v5 the OAS adapter is its own field — it is not a plugin.
  adapter: adapterOas({ validate: false }),
  plugins: [
    pluginTs({ output: { path: 'types' } }),
    pluginZod({ output: { path: 'schemas' } }),
    pluginReactQuery({ output: { path: 'hooks' } }),
  ],
})
