import { useQuery } from '@tanstack/react-query'
import { getApiLibraryAgentsQueryOptions } from '@/shared/api/generated/hooks/useGetApiLibraryAgents'
import { getApiLibrarySkillsQueryOptions } from '@/shared/api/generated/hooks/useGetApiLibrarySkills'

/** Global agents, each marked orchestrator or subagent. */
export function useLibraryAgents() {
  return useQuery(getApiLibraryAgentsQueryOptions())
}

export function useLibrarySkills() {
  return useQuery(getApiLibrarySkillsQueryOptions())
}
