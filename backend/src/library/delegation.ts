// Subagent delegation guidance for orchestrator agents.
//
// Why this is injected rather than left to each agent's author:
//
// Claude Opus 5 delegates to subagents far more readily than earlier models,
// and it multiplies cost and latency when applied to small tasks. Claude Code
// adds a delegation instruction of its own ONLY when you use its `claude_code`
// system-prompt preset. An orchestrator's markdown body IS a custom system
// prompt, so that safeguard does not apply here and Opus 5's eagerness runs
// unchecked unless we say something.
//
// Text below is the instruction Anthropic documents for this, used verbatim:
// https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
export const DELEGATION_INSTRUCTION = `Delegate to a subagent only for large tasks that are genuinely independent and parallelizable, such as a wide multi-file investigation. Do not delegate work you can finish yourself in a handful of tool calls, and do not use subagents to verify or double-check your own work. If one subagent can complete the task, use one rather than several, and keep spawn counts low.`

const MARKER = '<!-- agentoo:delegation -->'

// Appended, not prepended: the agent's own instructions should be what the model
// reads first. Idempotent, so re-running a session never stacks copies.
export function withDelegationGuidance(prompt: string): string {
  if (prompt.includes(MARKER) || prompt.includes(DELEGATION_INSTRUCTION)) return prompt
  return `${prompt.trimEnd()}\n\n${MARKER}\n<delegation>\n${DELEGATION_INSTRUCTION}\n</delegation>\n`
}

// Deterministic caps to pair with the instruction, since prompting only steers.
// Passed through the SDK's `env` option. Defaults are 3 and 20 respectively,
// which is far more concurrency than a single-box deployment wants.
export function delegationEnv(maxDepth: number, maxConcurrent: number): Record<string, string> {
  return {
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(maxDepth),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(maxConcurrent),
  }
}
