import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { checkLibraryName } from './types'

/**
 * Sits beside SKILL.md, never inside its frontmatter.
 *
 * `updateSkill` (features/library/service.ts) rewrites SKILL.md through
 * `skillToMarkdown(name, description, body)`, which only ever emits `name` and
 * `description` — any other frontmatter key an operator had added is gone the
 * first time they save an edit in the library UI. A sibling file has no such
 * writer pointed at it, so it survives every edit to the skill's prompt. It
 * also already travels with the skill for free: `materialise` in
 * features/library/service.ts assigns a skill by `cp -r`'ing the whole
 * directory into a project's plugin folder, so this file is copied right
 * along with SKILL.md with no extra plumbing.
 */
export const SKILL_MCP_FILE = 'mcp.json'

/**
 * stdio only. A library skill is authored by whoever can edit the library —
 * nothing in that UI reviews an `mcp.json` the way it reviews a prompt — so an
 * `http`/`sse` entry (a bare `url`) would let a skill silently point every
 * session that loads it at an arbitrary remote endpoint. A stdio command runs
 * *on this box*, which is no wider a blast radius than `Bash` already grants
 * every session, so allowing it adds no new capability. `z.strictObject`
 * rather than `z.object` is what actually enforces this: an entry carrying
 * `url`, or `type: 'http' | 'sse'`, fails as an unknown/mismatched key rather
 * than being silently accepted with the dangerous field ignored.
 *
 * No `${VAR}` expansion: this file is read and parsed by us, not handed to
 * the CLI's own `.mcp.json` loader (that loader is exactly what
 * `skipMcpDiscovery: true` on the plugin turns off — see runner-options.ts),
 * so any expansion would be a feature we would have to implement ourselves.
 * Not implementing it is the smaller, honest contract; it is additive to add
 * later if a skill ever needs it.
 */
const mcpStdioServerSchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
})

/**
 * Only the shape checked at this level is "does this file parse as
 * `{ mcpServers: { ... } }` at all". Each entry's own shape (stdio-only) and
 * each name's own shape (checkLibraryName) are validated per-entry below, so
 * one bad entry cannot take a whole skill's otherwise-valid servers down with
 * it — only a file that fails at *this* level does that.
 */
const skillMcpFileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A one-line reason, matching `describeError` in library/index.ts. */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Every MCP server declared by the skills in a directory, keyed by server
 * name.
 *
 * Takes a directory rather than defaulting to the library, exactly like
 * `listAgents(dir)` — the only honest answer to "which MCP servers does this
 * session actually have" is the project's plugin copy, the one the SDK loads,
 * not the shared library it was copied from.
 *
 * A skill with no `mcp.json` is the ordinary case and produces no warning. A
 * skill whose `mcp.json` fails to parse — bad JSON, or a shape that does not
 * even match `{ mcpServers: {...} }` — has that skill's servers skipped
 * entirely and a warning logged; it never fails the session, the same
 * discipline `listAgents`/`listSkills` already use for a bad file. Below that
 * level, a single malformed entry (a non-stdio server, an entry that fails
 * the stdio schema, or an invalid server name) is skipped on its own, warned
 * individually, without discarding the rest of that skill's servers.
 *
 * Server names collide across skills sometimes — two skills each shipping,
 * say, a "playwright" server — and the first one encountered wins; the second
 * is warned and dropped rather than silently overwriting the first, since a
 * silent overwrite would make which server actually runs depend on directory
 * iteration order with nothing in the logs to explain it.
 */
export async function skillMcpServers(
  skillsDir: string,
): Promise<Record<string, McpStdioServerConfig>> {
  if (!(await exists(skillsDir))) return {}

  const entries = await readdir(skillsDir, { withFileTypes: true })
  // Sorted for the same reason listAgents/listSkills sort their own results:
  // "first skill wins" needs a stable order to mean anything, and raw
  // `readdir` order is filesystem-dependent, not alphabetical.
  const skillNames = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .sort()

  const servers: Record<string, McpStdioServerConfig> = {}
  // Which skill first claimed each server name, purely for the collision
  // warning below — never consulted to decide behaviour.
  const claimedBy = new Map<string, string>()

  for (const skillName of skillNames) {
    const filePath = join(skillsDir, skillName, SKILL_MCP_FILE)
    if (!(await exists(filePath))) continue

    let parsedFile: z.infer<typeof skillMcpFileSchema>
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'))
      parsedFile = skillMcpFileSchema.parse(raw)
    } catch (error) {
      logger.warn(`Skipping MCP servers in skill "${skillName}" — ${describeError(error)}`)
      continue
    }

    for (const [name, rawServer] of Object.entries(parsedFile.mcpServers)) {
      // The name becomes `mcp__<name>__<tool>` in every tool call the SDK
      // makes and in any agent's `disallowedTools` — a public contract other
      // agents and library skills are written against, not an implementation
      // detail — so it is checked exactly like a library name (no `__`, no
      // path characters) rather than merely "is this a valid JSON key".
      const nameCheck = checkLibraryName(name)
      if (!nameCheck.ok) {
        logger.warn(`Skipping MCP server "${name}" from skill "${skillName}" — ${nameCheck.reason}`)
        continue
      }

      const shaped = mcpStdioServerSchema.safeParse(rawServer)
      if (!shaped.success) {
        logger.warn(
          `Skipping MCP server "${name}" from skill "${skillName}" — ${describeError(shaped.error)}`,
        )
        continue
      }

      const existingOwner = claimedBy.get(name)
      if (existingOwner !== undefined) {
        logger.warn(
          `MCP server "${name}" is declared by both "${existingOwner}" and "${skillName}"; keeping "${existingOwner}"'s.`,
        )
        continue
      }

      claimedBy.set(name, skillName)
      servers[name] = shaped.data
    }
  }

  return servers
}
