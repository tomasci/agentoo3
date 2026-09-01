import { client } from '@/shared/api/generated/.kubb/client'
import { logger } from '@/shared/lib/logger'

// The generated operations already carry `/api/...` URLs, and nginx serves the
// frontend and the API from one origin (the Vite dev server proxies /api), so
// no baseURL is needed. VITE_API_URL is the escape hatch for pointing at an API
// on another host.
export function configureApiClient(): void {
  const baseURL = import.meta.env.VITE_API_URL
  if (baseURL) client.setConfig({ baseURL })

  client.interceptors.error.use((error) => {
    // Log once, centrally; components decide what to show.
    const status = (error as { status?: number }).status
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`API error${status ? ` ${status}` : ''}: ${message}`)
    return error
  })
}

export { client }
