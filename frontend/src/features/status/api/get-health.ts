import { apiClient } from '@/shared/api/client'
import { type Health, healthSchema } from '../model/status.schema'

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const { data } = await apiClient.get('/health', { signal })
  // Parse rather than cast: a backend that changes shape should fail here,
  // not three components deep.
  return healthSchema.parse(data)
}
