// The pure text pipeline for the Idea Manager: turning a canvas's content into
// the deterministic document a one-shot model call reads, both for the first
// "send this idea to a session" generation and for the follow-up round that
// folds in what the session actually did and what the user said back.
//
// No I/O, no database, no logging — every export here is a total function of
// its arguments. That is what lets the exact string a model sees be pinned in
// a test rather than merely eyeballed: the same idea has to produce the same
// document today, tomorrow, and regardless of what order a database handed
// its rows back in.
//
// These are our own input types, not the database's. `db/schema.ts` is being
// written by another track in parallel, and importing its rows (or drizzle's
// generated types) here would tie this module's shape to a schema that has
// not landed yet, and could not be tested without one either. Whatever calls
// in here — the queue/worker code that does own the schema — maps a row onto
// one of these before calling; that mapping is where a shape drifting between
// the two tracks would be caught, not swallowed.

export type IdeaBlockKind = 'note' | 'requirement' | 'example' | 'link' | 'image'

interface BlockCommon {
  id: string
  /**
   * Explicit reading order, allocated from a per-idea counter when a block is
   * created or dragged to a new position in the reading order. This is the
   * ONLY thing that decides where a block lands in the document below.
   */
  seq: number
  /** The group this block belongs to, or null for an ungrouped block. */
  groupId: string | null
}

/**
 * A typed content block. Deliberately carries no `x`, `y`, `w` or `h` — the
 * canvas coordinates a block also has in the real schema are excluded from
 * this type entirely, not merely left unread by convention.
 *
 * A single number cannot honestly be both a place on a plane and a place in a
 * reading order. If geometry could reach this far, a `seq` that silently fell
 * back to a canvas coordinate — or a future refactor that read `x` "just to
 * break a tie" — would make nudging a card four pixels to the right a real,
 * invisible reorder of the prompt a model goes on to read, with no diff, no
 * log line and no visible cause to point at. Excluding the fields structurally
 * — there is nothing here to read even if some future caller reached for it —
 * is what keeps that failure mode unreachable rather than merely unlikely.
 */
export type IdeaBlockInput =
  | (BlockCommon & { kind: 'note'; text: string })
  | (BlockCommon & { kind: 'requirement'; text: string })
  | (BlockCommon & { kind: 'example'; text: string })
  | (BlockCommon & { kind: 'link'; url: string; label: string | null })
  | (BlockCommon & { kind: 'image'; assetId: string; caption: string | null })

/**
 * A named cluster of blocks, rendered as a heading. Same exclusion, same
 * reason as `IdeaBlockInput`: no `x`, `y`, `w` or `h` here either.
 */
export interface IdeaGroupInput {
  id: string
  seq: number
  title: string
}

/**
 * Name and metadata for a file attached to the idea — never its bytes. This is
 * what tells a model an image or document exists and what it is called; the
 * content itself is the orchestrator's to go read later, once it has a working
 * directory, not something to inline into a one-shot prompt.
 */
export interface IdeaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface IdeaInput {
  title: string
  blocks: IdeaBlockInput[]
  groups: IdeaGroupInput[]
  assets: IdeaAssetInput[]
}

/** One unconsumed feedback comment, folded into a follow-up document. */
export interface IdeaCommentInput {
  id: string
  text: string
  createdAt: string
}

const KIND_LABEL: Record<IdeaBlockKind, string> = {
  note: 'Note',
  requirement: 'Requirement',
  example: 'Example',
  link: 'Link',
  image: 'Image',
}

/**
 * `seq` first, `id` second. The tie-break matters as much as the primary key:
 * two rows that somehow share a `seq` (a bug upstream, a race on allocation)
 * must not let the order the caller happened to pass them in decide the
 * output — that would make the same idea serialize differently depending on
 * which database read raced ahead, which is exactly the kind of thing this
 * module exists to make impossible.
 */
function bySeqThenId<T extends { seq: number; id: string }>(a: T, b: T): number {
  return a.seq - b.seq || a.id.localeCompare(b.id)
}

/** Same reasoning as `bySeqThenId`, for the one list that has no `seq`. */
function byCreatedAtThenId<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(1)} ${units[i]}`
}

/**
 * One block, labelled with its kind so a model can tell a hard requirement
 * from a stray thought without inferring it from tone. A `link` or `image`
 * whose reference does not resolve is a data-integrity problem from whatever
 * assembled this idea, not something to paper over here — it throws rather
 * than silently printing a broken reference into a document a model will
 * trust as ground truth.
 */
function renderBlock(block: IdeaBlockInput, assetsById: Map<string, IdeaAssetInput>): string {
  const label = KIND_LABEL[block.kind]
  switch (block.kind) {
    case 'note':
    case 'requirement':
    case 'example':
      return `**${label}.** ${block.text}`
    case 'link':
      return block.label
        ? `**${label}.** ${block.label} — ${block.url}`
        : `**${label}.** ${block.url}`
    case 'image': {
      const asset = assetsById.get(block.assetId)
      if (!asset) {
        throw new Error(
          `Block ${block.id} references asset ${block.assetId}, which is not in idea.assets`,
        )
      }
      return block.caption
        ? `**${label}.** ${asset.filename} — ${block.caption}`
        : `**${label}.** ${asset.filename}`
    }
  }
}

/**
 * Filename, mime type and size for every attached asset — names and metadata
 * only, never file contents. Sorted by filename (then id, for the same
 * tie-break reason as everywhere else) since assets carry no `seq` of their
 * own: nothing about their canvas position or upload order is part of this
 * document's contract.
 */
function renderAssetManifest(assets: IdeaAssetInput[]): string[] {
  return [...assets]
    .sort((a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id))
    .map((a) => `- ${a.filename} — ${a.mimeType}, ${humanSize(a.sizeBytes)}`)
}

/**
 * Render an idea's content into the deterministic document a one-shot model
 * call reads to produce a development prompt.
 *
 * Ordering: ungrouped blocks first (ascending `seq`), then each group in
 * ascending `group.seq`, with that group's own members in ascending `seq`
 * beneath its heading. Every list is re-sorted here rather than trusted from
 * the caller's array order, so the same idea produces the same string
 * regardless of what order a database happened to return its rows in.
 */
export function serializeIdea(idea: IdeaInput): string {
  const assetsById = new Map(idea.assets.map((a) => [a.id, a]))
  const groupsById = new Map(idea.groups.map((g) => [g.id, g]))

  for (const block of idea.blocks) {
    if (block.groupId !== null && !groupsById.has(block.groupId)) {
      throw new Error(
        `Block ${block.id} references group ${block.groupId}, which is not in idea.groups`,
      )
    }
  }

  const membersOf = (groupId: string | null) =>
    idea.blocks.filter((b) => b.groupId === groupId).sort(bySeqThenId)

  const lines: string[] = [`# ${idea.title}`, '']

  const ungrouped = membersOf(null)
  if (ungrouped.length > 0) {
    lines.push(ungrouped.map((b) => renderBlock(b, assetsById)).join('\n\n'), '')
  }

  for (const group of [...idea.groups].sort(bySeqThenId)) {
    lines.push(`## ${group.title}`, '')
    const members = membersOf(group.id)
    if (members.length > 0) {
      lines.push(members.map((b) => renderBlock(b, assetsById)).join('\n\n'), '')
    }
  }

  if (idea.assets.length > 0) {
    lines.push('## Assets', '', ...renderAssetManifest(idea.assets), '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Render the source document for a follow-up prompt: the idea's content
 * again (so nothing already said is lost), the prompt already generated and
 * sent, a digest of what the session actually did with it, and whichever
 * feedback comments have not yet been folded into a prompt. Held to the same
 * determinism rules as `serializeIdea` — same input twice is the same string,
 * and the caller's comment order never leaks through.
 *
 * `previousPrompt` and `sessionDigest` are taken as already-composed strings
 * rather than structured input: unlike the idea's own content, neither has an
 * ordering rule of its own to enforce, so there is nothing this function would
 * add by taking them apart and reassembling them.
 */
export function serializeIdeaFollowUp(
  idea: IdeaInput,
  previousPrompt: string,
  sessionDigest: string,
  comments: IdeaCommentInput[],
): string {
  const lines: string[] = [
    `# Follow-up for: ${idea.title}`,
    '',
    '## Idea content',
    '',
    serializeIdea(idea).trimEnd(),
    '',
    '## Prompt already sent to the session',
    '',
    previousPrompt.trim(),
    '',
    '## What the session did',
    '',
    sessionDigest.trim(),
    '',
  ]

  const sortedComments = [...comments].sort(byCreatedAtThenId)
  if (sortedComments.length > 0) {
    lines.push('## New feedback', '', ...sortedComments.map((c) => `- ${c.text}`), '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}
