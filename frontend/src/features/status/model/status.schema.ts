import { z } from 'zod'

// The backend does not exist yet; this is the shape it is expected to return
// from GET /api/health. Kubb will replace hand-written schemas like this once
// there is an OpenAPI spec to generate from.
export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string().optional(),
})

export type Health = z.infer<typeof healthSchema>
