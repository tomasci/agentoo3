import { createConsola } from 'consola'
import { env } from '@/env'

export const logger = createConsola({ level: env.LOG_LEVEL }).withTag('agentoo')
