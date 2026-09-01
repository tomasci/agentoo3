import { z } from 'zod'

// Parsed once at startup so a missing or malformed value fails loudly here,
// rather than as undefined halfway through a request.
const schema = z.object({
  apiUrl: z.string().min(1),
  appName: z.string().min(1),
})

export const env = schema.parse({
  apiUrl: import.meta.env.VITE_API_URL ?? '/api',
  appName: import.meta.env.VITE_APP_NAME ?? 'agentoo',
})

export const isProd = import.meta.env.PROD
