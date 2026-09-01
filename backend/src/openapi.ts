// Writes the OpenAPI document to disk so the frontend can generate its client
// without a running server. Committed, so codegen is reproducible in CI and on
// a fresh checkout.
//
//   bun run openapi

import { createApp } from '@/app'

const app = createApp()
const res = await app.request('/api/openapi.json')

if (!res.ok) {
  console.error(`Could not render the OpenAPI document: ${res.status}`)
  process.exit(1)
}

const spec = await res.json()
const out = new URL('../openapi.json', import.meta.url).pathname
await Bun.write(out, `${JSON.stringify(spec, null, 2)}\n`)
console.log(`Wrote ${out}`)

// createApp() pulls in the BullMQ queue, whose Redis connection retries forever
// and keeps the event loop alive. Nothing here needs draining, so exit.
process.exit(0)
