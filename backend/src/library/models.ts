// The shape a Claude model option comes in, and the built-in list this app
// falls back to when the real one — Query.supportedModels() from the agent
// SDK, probed in features/system/models.ts — could not be reached.
//
// Lives beside types.ts rather than in features/system/, the same way that
// file owns the frontmatter contract: this is the type both the fallback list
// and the live probe's result are shaped as, and the system feature's own
// schema.ts mirrors it for the OpenAPI document exactly the way
// features/library/schema.ts mirrors agentFrontmatterSchema from ./types.ts.

export interface ModelOption {
  /**
   * What actually gets written into an agent's `model` frontmatter (see
   * agentFrontmatterSchema in ./types.ts) or a session's model override, and
   * handed to the SDK verbatim. Not restricted to a known shape here on
   * purpose — the agent SDK's own list has included values with brackets in
   * them (`opus[1m]`), and Claude Code, not this app, is the thing that
   * actually knows what it will accept.
   */
  value: string
  /** Canonical wire model id this row's `value` resolves to, e.g. 'sonnet' -> 'claude-sonnet-5'. */
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

/**
 * Aliases only — never a pinned wire id like `claude-opus-5`. An alias
 * resolves forward to whatever that name currently means, so this list ages
 * the same way the hardcoded `['opus', 'sonnet', 'haiku']` it replaces
 * already has (frontend/src/features/library/model/tools.ts); a wire id
 * checked in here would eventually name a retired model and turn a "we
 * couldn't reach Claude Code" fallback into its own outage. `default` and
 * `inherit` are deliberately absent: `default` is a live-probe-only value
 * with no fixed meaning to hardcode, and `inherit` is an agent-frontmatter-
 * only concept the SDK never returns and the UI adds on its own.
 */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: 'opus', displayName: 'Opus', description: 'Best for everyday, complex tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient for routine tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' },
]
