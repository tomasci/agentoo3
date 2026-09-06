import { z } from 'zod'

// Parsed once at startup so a missing or malformed value fails loudly here,
// rather than as undefined halfway through a request.
const schema = z.object({
  apiUrl: z.string().min(1),
  appName: z.string().min(1),
  appVersion: z.string().min(1),
})

// __APP_VERSION__ only exists once esbuild's `define` (vite.config.ts) has
// substituted it for the literal from version.json — true for both `vite dev`
// and `vite build`, but not for `bun test`, which runs this file unbundled. A
// bare reference would throw a ReferenceError the moment any test imports
// this module (most do, transitively, via api/client.ts); `typeof` is the one
// operator JS lets you apply to an undeclared identifier without throwing, so
// the fallback only ever gets exercised in that untransformed case.
const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

export const env = schema.parse({
  apiUrl: import.meta.env.VITE_API_URL ?? '/api',
  appName: import.meta.env.VITE_APP_NAME ?? 'agentoo',
  appVersion,
})

export const isProd = import.meta.env.PROD
