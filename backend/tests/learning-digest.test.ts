// features/learning/digest.ts: realistic message payloads (the shapes
// session-run.worker.ts's own appendMessage/titleFor already document) folded
// into one bounded digest, plus the truncation helper both digest.ts and the
// rest of the engine's text-bounding relies on.

import { expect, test } from 'bun:test'
import './setup-env'
import {
  DIGEST_ITEM_MAX_CHARS,
  DIGEST_SESSION_MAX_CHARS,
  type DigestMessageRow,
  digestSession,
  truncateKeepingEnds,
} from '@/features/learning/digest'

const header = {
  projectName: 'demo-project',
  title: 'Fix the export button',
  orchestrator: 'orchestrator',
  status: 'completed',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  totalCostUsd: 1.2345,
}

function row(partial: Partial<DigestMessageRow>): DigestMessageRow {
  return { type: 'assistant', parentToolUseId: null, payload: {}, ...partial }
}

test('an empty session (no rows) digests to null', () => {
  expect(digestSession(header, [])).toBeNull()
})

test('a session with only bookkeeping rows (stream_event, rate_limit_event, init) digests to null', () => {
  const rows: DigestMessageRow[] = [
    row({ type: 'stream_event', payload: { event: { type: 'content_block_delta' } } }),
    row({ type: 'rate_limit_event', payload: {} }),
    row({ type: 'system', payload: { subtype: 'init', model: 'claude-sonnet-5' } }),
    row({ type: 'system', payload: { subtype: 'task_progress', summary: 'thinking' } }),
  ]
  expect(digestSession(header, rows)).toBeNull()
})

test('includes the header, an operator prompt and an auto-continuation distinctly', () => {
  const rows: DigestMessageRow[] = [
    row({ type: 'prompt', payload: { text: 'Please add an export button.' } }),
    row({ type: 'prompt', payload: { text: 'Keep going.', auto: true } }),
  ]
  const text = digestSession(header, rows)
  expect(text).not.toBeNull()
  expect(text).toContain('Session: demo-project — Fix the export button')
  expect(text).toContain('Orchestrator: orchestrator')
  expect(text).toContain('Status: completed')
  expect(text).toContain('Cost: $1.2345')
  expect(text).toContain('Operator: Please add an export button.')
  expect(text).toContain('System (auto-continuation): Keep going.')
})

test('assistant text and tool_use blocks become one-line entries, labelled by who said them', () => {
  const rows: DigestMessageRow[] = [
    row({
      type: 'assistant',
      parentToolUseId: null,
      payload: { message: { content: [{ type: 'text', text: "I'll add the button now." }] } },
    }),
    row({
      type: 'assistant',
      parentToolUseId: null,
      payload: {
        message: {
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'bun test' } }],
        },
      },
    }),
    row({
      type: 'assistant',
      parentToolUseId: null,
      payload: {
        message: {
          content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/repo/a.ts' } }],
        },
      },
    }),
  ]
  const text = digestSession(header, rows)
  expect(text).toContain('orchestrator: I\'ll add the button now.')
  expect(text).toContain('orchestrator tool call: Bash(bun test)')
  expect(text).toContain('orchestrator tool call: Read(/repo/a.ts)')
})

test('a delegated subagent\'s own messages are labelled by its subagent type, via task_started', () => {
  const rows: DigestMessageRow[] = [
    row({
      type: 'system',
      payload: {
        subtype: 'task_started',
        tool_use_id: 'tu_delegate',
        task_type: 'local_agent',
        subagent_type: 'agentoo:architect',
        description: 'Plan the export feature',
        prompt: 'Design an export button for the toolbar.',
      },
    }),
    row({
      type: 'assistant',
      parentToolUseId: 'tu_delegate',
      payload: { message: { content: [{ type: 'text', text: 'Looking at the toolbar now.' }] } },
    }),
  ]
  const text = digestSession(header, rows)
  expect(text).toContain('Delegated to architect: Plan the export feature — prompt: Design an export button for the toolbar.')
  expect(text).toContain('architect: Looking at the toolbar now.')
})

test('a backgrounded shell command\'s own task_started is not treated as a delegation', () => {
  const rows: DigestMessageRow[] = [
    row({
      type: 'system',
      payload: {
        subtype: 'task_started',
        tool_use_id: 'tu_bg',
        task_type: 'local_bash',
        description: 'git push',
        is_backgrounded: true,
      },
    }),
    row({ type: 'prompt', payload: { text: 'anchor so the digest is non-empty' } }),
  ]
  const text = digestSession(header, rows)
  expect(text).not.toContain('Delegated to')
})

test('ambient/skip_transcript task_started rows are not treated as delegations', () => {
  const rows: DigestMessageRow[] = [
    row({
      type: 'system',
      payload: {
        subtype: 'task_started',
        tool_use_id: 'tu_ambient',
        task_type: 'local_agent',
        subagent_type: 'housekeeping',
        description: 'warm cache',
        ambient: true,
      },
    }),
    row({ type: 'prompt', payload: { text: 'anchor so the digest is non-empty' } }),
  ]
  const text = digestSession(header, rows)
  expect(text).not.toContain('Delegated to')
})

test('a tool error (is_error result) is included, attributed to the tool that produced it, and truncated', () => {
  const longError = 'E'.repeat(1000)
  const rows: DigestMessageRow[] = [
    row({
      type: 'assistant',
      payload: {
        message: { content: [{ type: 'tool_use', id: 'tu_err', name: 'Bash', input: { command: 'bad-cmd' } }] },
      },
    }),
    row({
      type: 'user',
      payload: {
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_err', is_error: true, content: longError }],
        },
      },
    }),
  ]
  const text = digestSession(header, rows)
  expect(text).not.toBeNull()
  expect(text).toContain('Tool error (Bash):')
  // The per-item cap (DIGEST_ITEM_MAX_CHARS) bounds how much of the raw error
  // text survives — never the whole 1000-char string verbatim.
  expect(text).not.toContain(longError)
})

test('a successful (non-error) tool_result produces no line of its own', () => {
  const rows: DigestMessageRow[] = [
    row({
      type: 'user',
      payload: {
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_ok', is_error: false, content: 'all good' }],
        },
      },
    }),
    row({ type: 'prompt', payload: { text: 'anchor so the digest is non-empty' } }),
  ]
  const text = digestSession(header, rows)
  expect(text).not.toContain('all good')
})

test('a final result message records its subtype and error flag, truncating the result text', () => {
  const longText = 'R'.repeat(1000)
  const rows: DigestMessageRow[] = [
    row({ type: 'result', payload: { subtype: 'success', is_error: false, result: longText } }),
  ]
  const text = digestSession(header, rows)
  expect(text).toContain('Result: subtype=success error=false —')
  expect(text).not.toContain(longText)
})

test('an error-subtype result still records is_error honestly', () => {
  const rows: DigestMessageRow[] = [
    row({ type: 'result', payload: { subtype: 'error_max_turns', is_error: true, result: 'hit the turn limit' } }),
  ]
  const text = digestSession(header, rows)
  expect(text).toContain('Result: subtype=error_max_turns error=true — hit the turn limit')
})

// --- truncateKeepingEnds -----------------------------------------------------

test('truncateKeepingEnds leaves short text untouched', () => {
  expect(truncateKeepingEnds('short', 100)).toBe('short')
})

test('truncateKeepingEnds keeps the head and the tail, with an explicit elision marker', () => {
  const text = `${'A'.repeat(500)}MIDDLE${'B'.repeat(500)}`
  const out = truncateKeepingEnds(text, 200)
  expect(out.length).toBeLessThanOrEqual(200)
  expect(out).toContain('characters omitted')
  expect(out.startsWith('A')).toBe(true)
  expect(out.endsWith('B')).toBe(true)
  // The omitted middle content is genuinely gone, not merely hidden.
  expect(out).not.toContain('MIDDLE')
})

test('digestSession enforces its own per-session cap even when every individual line is small', () => {
  const rows: DigestMessageRow[] = Array.from({ length: 500 }, (_, i) =>
    row({ type: 'prompt', payload: { text: `line ${i} `.repeat(10) } }),
  )
  const text = digestSession(header, rows)
  expect(text).not.toBeNull()
  expect((text as string).length).toBeLessThanOrEqual(DIGEST_SESSION_MAX_CHARS)
  expect(text).toContain('characters omitted')
})

test('a single item over DIGEST_ITEM_MAX_CHARS is truncated on its own', () => {
  const huge = 'X'.repeat(DIGEST_ITEM_MAX_CHARS * 3)
  const rows: DigestMessageRow[] = [row({ type: 'prompt', payload: { text: huge } })]
  const text = digestSession(header, rows) as string
  // Header + one line, bounded by the per-item cap plus the elision marker's
  // own small overhead — nowhere near the original 3x length.
  expect(text.length).toBeLessThan(huge.length)
})
