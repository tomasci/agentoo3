// Mirrors the backend's own KNOWN_PROMPTS (backend/src/features/system/prompts.ts)
// because that API deliberately has no list endpoint — a prompt is looked up
// by a fixed name, never enumerated. Adding a prompt means adding one entry
// here and one there.
export const KNOWN_PROMPTS = ['idea-to-prompt', 'session-learning'] as const
