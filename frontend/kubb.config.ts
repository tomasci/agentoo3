// OpenAPI -> typed models + zod schemas + react-query hooks.
//
// Neither the rendered spec nor the generated client is committed — see
// frontend/.gitignore for why. So a build very much does depend on codegen
// having run: without it, tsc and vite both fail on "Cannot find module
// @/shared/api/generated/...".
//
// Nothing here needs running by hand. scripts/gen-api-client.sh renders the
// spec and generates the client in one step: pre-push runs it unconditionally,
// pre-commit only when a checkout has no client at all, and install.sh does the
// same two steps on a fresh machine.

import { adapterOas } from '@kubb/adapter-oas'
import { pluginAxios } from '@kubb/plugin-axios'
import { pluginReactQuery } from '@kubb/plugin-react-query'
import { pluginTs } from '@kubb/plugin-ts'
import { pluginZod } from '@kubb/plugin-zod'
import { defineConfig } from 'kubb'

export default defineConfig({
  root: '.',
  // v5 takes a plain path, so codegen reads a file and never needs the backend
  // running. Rendering that file is backend's `bun run openapi`, which is the
  // step gen-api-client.sh does first.
  input: process.env.OPENAPI_SPEC ?? '../backend/openapi.json',
  output: {
    path: './src/shared/api/generated',
    clean: true,
  },
  // In v5 the OAS adapter is its own field — it is not a plugin.
  adapter: adapterOas({ validate: false }),
  plugins: [pluginTs(), pluginAxios(), pluginZod(), pluginReactQuery()],
})
