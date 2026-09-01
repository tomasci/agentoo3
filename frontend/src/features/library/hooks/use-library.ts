import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteApiLibraryAgentsNameMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiLibraryAgentsName'
import { deleteApiLibrarySkillsNameMutationOptions } from '@/shared/api/generated/hooks/useDeleteApiLibrarySkillsName'
import {
  getApiLibraryAgentsQueryKey,
  getApiLibraryAgentsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiLibraryAgents'
import { getApiLibraryAgentsNameQueryOptions } from '@/shared/api/generated/hooks/useGetApiLibraryAgentsName'
import {
  getApiLibrarySkillsQueryKey,
  getApiLibrarySkillsQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiLibrarySkills'
import { getApiLibrarySkillsNameQueryOptions } from '@/shared/api/generated/hooks/useGetApiLibrarySkillsName'
import {
  getApiProjectsIdLibraryQueryKey,
  getApiProjectsIdLibraryQueryOptions,
} from '@/shared/api/generated/hooks/useGetApiProjectsIdLibrary'
import { postApiLibraryAgentsMutationOptions } from '@/shared/api/generated/hooks/usePostApiLibraryAgents'
import { postApiLibrarySkillsMutationOptions } from '@/shared/api/generated/hooks/usePostApiLibrarySkills'
import { putApiLibraryAgentsNameMutationOptions } from '@/shared/api/generated/hooks/usePutApiLibraryAgentsName'
import { putApiLibrarySkillsNameMutationOptions } from '@/shared/api/generated/hooks/usePutApiLibrarySkillsName'
import { putApiProjectsIdLibraryMutationOptions } from '@/shared/api/generated/hooks/usePutApiProjectsIdLibrary'
import type { GetApiLibraryAgentsStatus200 } from '@/shared/api/generated/types/GetApiLibraryAgents'
import type { GetApiLibraryAgentsNameStatus200 } from '@/shared/api/generated/types/GetApiLibraryAgentsName'
import type { GetApiLibrarySkillsStatus200 } from '@/shared/api/generated/types/GetApiLibrarySkills'

export type AgentSummary = GetApiLibraryAgentsStatus200[number]
export type Agent = GetApiLibraryAgentsNameStatus200
export type Skill = GetApiLibrarySkillsStatus200[number]

export function useAgents() {
  return useQuery(getApiLibraryAgentsQueryOptions())
}
export function useSkills() {
  return useQuery(getApiLibrarySkillsQueryOptions())
}
export function useAgent(name: string) {
  return useQuery({
    ...getApiLibraryAgentsNameQueryOptions({ path: { name } }),
    enabled: Boolean(name),
  })
}
export function useSkill(name: string) {
  return useQuery({
    ...getApiLibrarySkillsNameQueryOptions({ path: { name } }),
    enabled: Boolean(name),
  })
}

function useInvalidateLibrary() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: getApiLibraryAgentsQueryKey() })
    void queryClient.invalidateQueries({ queryKey: getApiLibrarySkillsQueryKey() })
  }
}

export function useCreateAgent() {
  const invalidate = useInvalidateLibrary()
  return useMutation({ ...postApiLibraryAgentsMutationOptions(), onSuccess: invalidate })
}
export function useUpdateAgent() {
  const invalidate = useInvalidateLibrary()
  return useMutation({ ...putApiLibraryAgentsNameMutationOptions(), onSuccess: invalidate })
}
export function useDeleteAgent() {
  const invalidate = useInvalidateLibrary()
  return useMutation({ ...deleteApiLibraryAgentsNameMutationOptions(), onSuccess: invalidate })
}
export function useCreateSkill() {
  const invalidate = useInvalidateLibrary()
  return useMutation({ ...postApiLibrarySkillsMutationOptions(), onSuccess: invalidate })
}
export function useUpdateSkill() {
  const invalidate = useInvalidateLibrary()
  return useMutation({ ...putApiLibrarySkillsNameMutationOptions(), onSuccess: invalidate })
}
export function useDeleteSkill() {
  const invalidate = useInvalidateLibrary()
  return useMutation({ ...deleteApiLibrarySkillsNameMutationOptions(), onSuccess: invalidate })
}

// --- per-project assignment ---------------------------------------------------

export function useProjectLibrary(projectId: string) {
  return useQuery(getApiProjectsIdLibraryQueryOptions({ path: { id: projectId } }))
}

export function useSetProjectLibrary(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...putApiProjectsIdLibraryMutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: getApiProjectsIdLibraryQueryKey({ path: { id: projectId } }),
      })
      // Usage counts on the library list change too.
      void queryClient.invalidateQueries({ queryKey: getApiLibraryAgentsQueryKey() })
      void queryClient.invalidateQueries({ queryKey: getApiLibrarySkillsQueryKey() })
    },
  })
}
