// The Idea Manager: the board and detail pages (T11), plus the data layer
// they are built on — hooks over the generated client, the status
// vocabulary, and the react-hook-form schemas. Nothing below is exported
// merely because it exists; each entry is something the board, the detail
// page, or a form inside it needs.
//
// Pages sit in the same barrel as their hooks, the way
// `features/sessions/index.ts` does: a route adapter
// (`app/project-routes.tsx`) is the only caller outside this directory, and
// it needs the page components, not the pieces that build them.

export { IdeaBoardPage } from './components/idea-board-page'
export { IdeaDetailPage } from './components/idea-detail-page'
export {
  type IdeaAsset,
  type IdeaAssetsUsage,
  type IdeaAssetUpload,
  type IdeaAssetUploadStatus,
  useDeleteIdeaAsset,
  useIdeaAssets,
  useIdeaAssetUploads,
} from './hooks/use-idea-assets'
export {
  type IdeaBlock,
  type IdeaBlockKind,
  type IdeaGroup,
  useCreateIdeaBlock,
  useCreateIdeaGroup,
  useDeleteIdeaBlock,
  useDeleteIdeaGroup,
  useIdeaBlocks,
  useIdeaGroups,
  useUpdateIdeaBlock,
  useUpdateIdeaGroup,
} from './hooks/use-idea-canvas'
export {
  type IdeaComment,
  useCreateIdeaComment,
  useDeleteIdeaComment,
  useIdeaComments,
} from './hooks/use-idea-comments'
export { useContinueIdea } from './hooks/use-idea-continue'
export {
  type IdeaPrompt,
  type IdeaRun,
  useGenerateIdeaPrompt,
  useIdeaPrompts,
  useIdeaRuns,
} from './hooks/use-idea-prompts'
export {
  type Idea,
  type IdeaStatus,
  useCreateIdea,
  useDeleteIdea,
  useIdea,
  useIdeas,
  useMoveIdea,
  useUpdateIdea,
} from './hooks/use-ideas'

export { ideaAssetDownloadUrl, isInlineImage } from './lib/asset-url'
export {
  IDEA_STATUS_I18N_KEY,
  IDEA_STATUS_TONE,
  IDEA_STATUSES,
  isIdeaBusy,
} from './lib/status'
export { type IdeaBlockFormValues, ideaBlockFormSchema } from './model/idea-block.schema'
export {
  type CreateIdeaFormValues,
  createIdeaFormSchema,
  type UpdateIdeaFormValues,
  updateIdeaFormSchema,
} from './model/idea-form.schema'
