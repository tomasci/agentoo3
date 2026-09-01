/**
 * Tools offered as checkboxes in the agent editor.
 *
 * A UI concern, not a contract: the API accepts any string array, and omitting
 * `tools` entirely means the agent inherits every tool available to subagents.
 * Kept here so the list can grow without a backend change.
 */
export const AVAILABLE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
  'Agent',
  'Skill',
  'TodoWrite',
  'NotebookEdit',
] as const

export const MODELS = ['', 'opus', 'sonnet', 'haiku', 'inherit'] as const
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const
