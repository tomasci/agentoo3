// OpenAPI -> typed models + zod schemas + react-query hooks.
//
// Not part of `bun run build`: generated output is committed, so a build never
// depends on codegen succeeding. Run `bun run codegen` after the backend's
// routes change and commit the result.

import { adapterOas } from '@kubb/adapter-oas'
import { pluginAxios } from '@kubb/plugin-axios'
import { pluginReactQuery } from '@kubb/plugin-react-query'
import { pluginTs } from '@kubb/plugin-ts'
import { pluginZod } from '@kubb/plugin-zod'
import { defineConfig } from 'kubb'

export default defineConfig({
  root: '.',
  // v5 takes a plain path; the committed spec means codegen needs no server.
  // Regenerate with `bun run openapi` in backend/ after changing a route.
  input: process.env.OPENAPI_SPEC ?? '../backend/openapi.json',
  output: {
    path: './src/shared/api/generated',
    clean: true,
  },
  // In v5 the OAS adapter is its own field — it is not a plugin.
  adapter: adapterOas({ validate: false }),
  plugins: [pluginTs(), pluginAxios(), pluginZod(), pluginReactQuery()],
})
