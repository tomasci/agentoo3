// Validation for a branch name that a client supplies directly: a session's
// baseBranch override, and a project's defaultBranch setting.
//
// This is `git check-ref-format --branch` without the exotica (no `@{-1}`-style
// shorthand, no single-`@`, no per-component wildcard refspecs) — everything a
// human would ever type as a branch name, and nothing that lets the string do
// something other than name a ref. Modelled on `checkRemoteUrl` in
// `./remote-url.ts`, which validates a different untrusted git argument the
// same way: reject the dangerous shapes before the string ever reaches a
// subprocess argv.

import { hasControlChars } from './text'

const MAX_LENGTH = 255

// Reserved by git for reflog shorthand (`@{upstream}`, `@{-1}`, ...) and, as a
// bare `~ ^ : ? * [`, for revision ranges and glob refspecs. None of that is a
// legitimate branch name, and letting it through would let a "branch name"
// mean something other than a branch to a later git invocation.
const FORBIDDEN_CHARS = ['~', '^', ':', '?', '*', '[', '\\']

export type BranchNameCheck = { ok: true } | { ok: false; reason: string }

export function checkBranchName(name: string): BranchNameCheck {
  if (name.length === 0) return { ok: false, reason: 'Branch name is empty' }
  if (name.length > MAX_LENGTH) return { ok: false, reason: 'Branch name is too long' }

  // Whitespace and control characters are how command payloads get smuggled
  // into an argv slot that looks like ordinary text.
  if (/\s/.test(name) || hasControlChars(name)) {
    return { ok: false, reason: 'Branch name contains whitespace or control characters' }
  }

  // git parses a leading dash as an option, e.g. `--upload-pack=...` handed to
  // a command that shells out — the same argument-injection rule as
  // checkRemoteUrl.
  if (name.startsWith('-')) {
    return { ok: false, reason: 'Branch name may not start with "-"' }
  }
  if (name.startsWith('/')) {
    return { ok: false, reason: 'Branch name may not start with "/"' }
  }
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    return { ok: false, reason: 'Branch name may not end with "/", "." or ".lock"' }
  }
  if (name.includes('..') || name.includes('//') || name.includes('@{')) {
    return { ok: false, reason: 'Branch name may not contain "..", "//" or "@{"' }
  }
  if (FORBIDDEN_CHARS.some((c) => name.includes(c))) {
    return { ok: false, reason: 'Branch name may not contain ~ ^ : ? * [ or \\' }
  }
  // `.git/refs/heads/.foo` and `.git/refs/heads/a/.b` are both are refused by
  // git itself; checked per path component, not just at the start of the
  // whole name.
  if (name.split('/').some((part) => part.startsWith('.'))) {
    return { ok: false, reason: 'No path component of a branch name may start with "."' }
  }
  if (name === '@' || name === 'HEAD') {
    return { ok: false, reason: 'Branch name may not be "@" or "HEAD"' }
  }

  return { ok: true }
}
