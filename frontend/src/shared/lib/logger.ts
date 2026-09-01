import { createConsola } from 'consola'
import { isProd } from '@/shared/config/env'

export const logger = createConsola({
  // 3 = warn and above in production, 4 = info and above in development.
  level: isProd ? 3 : 4,
}).withTag('agentoo')
