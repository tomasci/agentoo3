import axios from 'axios'
import { env } from '@/shared/config/env'
import { logger } from '@/shared/lib/logger'

export const apiClient = axios.create({
  baseURL: env.apiUrl,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
})

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Log once, centrally, then let the caller decide what to show.
    if (axios.isAxiosError(error)) {
      logger.warn(`${error.config?.method?.toUpperCase()} ${error.config?.url} -> ${error.message}`)
    }
    return Promise.reject(error)
  },
)
