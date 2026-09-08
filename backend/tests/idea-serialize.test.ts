import { expect, spyOn, test } from 'bun:test'

// `@/library/idea-prompt` reaches `@/env` for LIBRARY_DIR, which has to be
// parsed before anything else imports it. See the note in setup-env.
import './setup-env'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../src/env'
import {
  type IdeaAssetInput,
  type IdeaBlockInput,
  type IdeaCommentInput,
  type IdeaGroupInput,
  type IdeaInput,
  serializeIdea,
  serializeIdeaFollowUp,
} from '../src/features/ideas/serialize'
import {
  IDEA_PROMPT_INSTRUCTION_FALLBACK,
  IDEA_PROMPT_PATH,
  ideaPromptAnswerSchema,
  loadIdeaPromptInstruction,
} from '../src/library/idea-prompt'
import { logger } from '../src/lib/logger'

// --- serializeIdea -----------------------------------------------------------

const asset = (overrides: Partial<IdeaAssetInput> = {}): IdeaAssetInput => ({
  id: 'a1',
  filename: 'export-mockup.png',
  mimeType: 'image/png',
  sizeBytes: 233472, // exactly 228.0 KB, so humanSize's rounding is exercised too
  ...overrides,
})

/**
 * A representative idea: ungrouped blocks (a requirement, a link, a note, out
 * of `seq` order in the array on purpose), two groups (also out of `seq`
 * order), and an image block that resolves against the asset manifest. This
 * is the fixture the "byte-identical" and "order-independent" tests below all
 * share, so a change to the rendered shape only has to be re-approved once.
 */
function csvExportIdea(): IdeaInput {
  return {
    title: 'Add CSV export',
    groups: [
      { id: 'g2', seq: 1, title: 'Export UI' },
      { id: 'g1', seq: 0, title: 'Backend' },
    ],
    assets: [asset()],
    blocks: [
      {
        id: 'b3',
        kind: 'note',
        seq: 2,
        groupId: null,
        text: 'Users have asked for this for months.',
      },
      {
        id: 'b1',
        kind: 'requirement',
        seq: 0,
        groupId: null,
        text: 'Exported files must use UTF-8 with a BOM for Excel compatibility.',
      },
      {
        id: 'b2',
        kind: 'link',
        seq: 1,
        groupId: null,
        url: 'https://example.com/spec',
        label: 'Prior art',
      },
      {
        id: 'c1',
        kind: 'requirement',
        seq: 0,
        groupId: 'g1',
        text: 'Streaming export, not building the whole file in memory.',
      },
      {
        id: 'c2',
        kind: 'example',
        seq: 1,
        groupId: 'g1',
        text: 'GET /export.csv?from=2026-01-01',
      },
      {
        id: 'd1',
        kind: 'image',
        seq: 0,
        groupId: 'g2',
        assetId: 'a1',
        caption: 'Mockup of the export button placement',
      },
    ],
  }
}

const CSV_EXPORT_GOLDEN =
  '# Add CSV export\n\n' +
  '**Requirement.** Exported files must use UTF-8 with a BOM for Excel compatibility.\n\n' +
  '**Link.** Prior art — https://example.com/spec\n\n' +
  '**Note.** Users have asked for this for months.\n\n' +
  '## Backend\n\n' +
  '**Requirement.** Streaming export, not building the whole file in memory.\n\n' +
  '**Example.** GET /export.csv?from=2026-01-01\n\n' +
  '## Export UI\n\n' +
  '**Image.** export-mockup.png — Mockup of the export button placement\n\n' +
  '## Assets\n\n' +
  '- export-mockup.png — image/png, 228.0 KB\n'

test('serializeIdea pins the exact document a model reads: labels, groups, and the asset manifest', () => {
  expect(serializeIdea(csvExportIdea())).toBe(CSV_EXPORT_GOLDEN)
})

test('same input twice is byte-identical', () => {
  const idea = csvExportIdea()
  expect(serializeIdea(idea)).toBe(serializeIdea(idea))
  expect(serializeIdea(csvExportIdea())).toBe(serializeIdea(csvExportIdea()))
})

test('shuffling the blocks array changes nothing: internal seq order wins over caller order', () => {
  const shuffled = csvExportIdea()
  // Reverse it, which is about as far from the fixture's own order as a
  // 6-element array gets without literally being the same permutation.
  shuffled.blocks = [...shuffled.blocks].reverse()
  expect(serializeIdea(shuffled)).toBe(CSV_EXPORT_GOLDEN)

  // Also true for groups: swap their array position, keep their seq.
  const groupsShuffled = csvExportIdea()
  groupsShuffled.groups = [...groupsShuffled.groups].reverse()
  expect(serializeIdea(groupsShuffled)).toBe(CSV_EXPORT_GOLDEN)
})

test('ungrouped blocks precede every group, and a group renders its members in seq order', () => {
  const out = serializeIdea(csvExportIdea())
  const ungroupedNote = out.indexOf('Users have asked for this for months.')
  const backendHeading = out.indexOf('## Backend')
  const exportUiHeading = out.indexOf('## Export UI')
  const backendRequirement = out.indexOf('Streaming export')
  const backendExample = out.indexOf('GET /export.csv')
  expect(ungroupedNote).toBeGreaterThanOrEqual(0)
  expect(backendHeading).toBeGreaterThan(ungroupedNote)
  // Backend (group.seq 0) before Export UI (group.seq 1), regardless of the
  // fixture listing them the other way round in idea.groups.
  expect(exportUiHeading).toBeGreaterThan(backendHeading)
  // Within Backend, the requirement (seq 0) precedes the example (seq 1).
  expect(backendExample).toBeGreaterThan(backendRequirement)
})

test('two blocks sharing a seq break the tie on id, independent of array order', () => {
  const build = (blocks: IdeaBlockInput[]): IdeaInput => ({
    title: 'Tie test',
    groups: [],
    assets: [],
    blocks,
  })
  const fromA: IdeaBlockInput = { id: 'aaa', kind: 'note', seq: 0, groupId: null, text: 'From A' }
  const fromB: IdeaBlockInput = { id: 'bbb', kind: 'note', seq: 0, groupId: null, text: 'From B' }

  const first = serializeIdea(build([fromA, fromB]))
  const second = serializeIdea(build([fromB, fromA]))
  expect(first).toBe(second)
  // 'aaa' sorts before 'bbb', so A's note comes first regardless of which one
  // the caller happened to list first.
  expect(first.indexOf('From A')).toBeLessThan(first.indexOf('From B'))
})

test('the asset manifest carries only names and metadata, never file contents', () => {
  const idea: IdeaInput = {
    title: 'Attachments only',
    groups: [],
    blocks: [],
    assets: [
      asset({ id: 'a1', filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 42 }),
      asset({ id: 'a2', filename: 'diagram.pdf', mimeType: 'application/pdf', sizeBytes: 10_485_760 }),
    ],
  }
  const out = serializeIdea(idea)
  expect(out).toContain('## Assets')
  expect(out).toContain('- notes.txt — text/plain, 42 B')
  expect(out).toContain('- diagram.pdf — application/pdf, 10.0 MB')
  // Nothing else about these two assets is even representable in an
  // IdeaAssetInput — there is no field to hold file bytes in the first place.
})

test('canvas coordinates cannot influence the document', () => {
  // Structurally, first: IdeaBlockInput and IdeaGroupInput have no x, y, w or
  // h field at all, so a caller cannot even construct one that carries a
  // canvas position — there is nothing here for a TypeScript object literal
  // to assign it to.
  //
  // This second check is defense in depth against a caller that bypasses the
  // type system anyway — e.g. by spreading a full database row, geometry
  // columns included, into what it hands to serializeIdea. Casting through
  // `unknown` recreates exactly that: extra x/y/w/h keys riding along on
  // otherwise-identical blocks and groups. The renderer never reads them, so
  // the output must still match the fixture with no such keys, byte for byte.
  const withGeometry = csvExportIdea()
  withGeometry.blocks = withGeometry.blocks.map(
    (b) => ({ ...b, x: 9999, y: -4321, w: 640, h: 480 }) as unknown as IdeaBlockInput,
  )
  withGeometry.groups = withGeometry.groups.map(
    (g) => ({ ...g, x: 111, y: 222, w: 50, h: 50 }) as unknown as IdeaGroupInput,
  )
  const out = serializeIdea(withGeometry)
  expect(out).toBe(CSV_EXPORT_GOLDEN)
  expect(out).not.toContain('9999')
  expect(out).not.toContain('4321')
})

test('a block whose groupId names no group fails loudly rather than silently misplacing it', () => {
  const idea: IdeaInput = {
    title: 'Broken reference',
    groups: [],
    assets: [],
    blocks: [{ id: 'b1', kind: 'note', seq: 0, groupId: 'ghost', text: 'x' }],
  }
  expect(() => serializeIdea(idea)).toThrow(/ghost/)
})

// --- serializeIdeaFollowUp ---------------------------------------------------

function followUpComments(): IdeaCommentInput[] {
  return [
    { id: 'c-x', text: 'Please also support semicolons.', createdAt: '2026-09-02T10:00:00.000Z' },
    { id: 'c-y', text: 'The button is hard to find.', createdAt: '2026-09-01T09:00:00.000Z' },
  ]
}

const FOLLOW_UP_GOLDEN =
  '# Follow-up for: Add CSV export\n\n' +
  '## Idea content\n\n' +
  '# Add CSV export\n\n' +
  '**Note.** Just a note.\n\n' +
  '## Prompt already sent to the session\n\n' +
  'Build the CSV export button.\n\n' +
  '## What the session did\n\n' +
  'Implemented the endpoint and wired the button.\n\n' +
  '## New feedback\n\n' +
  '- The button is hard to find.\n' +
  '- Please also support semicolons.\n'

function followUpIdea(): IdeaInput {
  return {
    title: 'Add CSV export',
    groups: [],
    assets: [],
    blocks: [{ id: 'b1', kind: 'note', seq: 0, groupId: null, text: 'Just a note.' }],
  }
}

test('serializeIdeaFollowUp composes the idea, the sent prompt, the digest and the new feedback, in that order', () => {
  const out = serializeIdeaFollowUp(
    followUpIdea(),
    'Build the CSV export button.',
    'Implemented the endpoint and wired the button.',
    followUpComments(),
  )
  expect(out).toBe(FOLLOW_UP_GOLDEN)
})

test('serializeIdeaFollowUp comments sort by createdAt then id, independent of array order', () => {
  const [x, y] = followUpComments()
  const forward = serializeIdeaFollowUp(
    followUpIdea(),
    'Build the CSV export button.',
    'Implemented the endpoint and wired the button.',
    [x as IdeaCommentInput, y as IdeaCommentInput],
  )
  const reversed = serializeIdeaFollowUp(
    followUpIdea(),
    'Build the CSV export button.',
    'Implemented the endpoint and wired the button.',
    [y as IdeaCommentInput, x as IdeaCommentInput],
  )
  expect(forward).toBe(reversed)
  expect(forward).toBe(FOLLOW_UP_GOLDEN)
})

// --- loadIdeaPromptInstruction -----------------------------------------------

/** Point LIBRARY_DIR at a scratch directory for the body, then restore it. */
async function withLibraryDir(dir: string, body: () => Promise<void>) {
  const previous = env.LIBRARY_DIR
  env.LIBRARY_DIR = dir
  try {
    await body()
  } finally {
    env.LIBRARY_DIR = previous
  }
}

test('loadIdeaPromptInstruction falls back to the built-in default when the file is absent, and warns once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-idea-prompt-'))
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined as never)
  try {
    await withLibraryDir(dir, async () => {
      const out = await loadIdeaPromptInstruction()
      expect(out).toBe(IDEA_PROMPT_INSTRUCTION_FALLBACK)
    })
    expect(warn).toHaveBeenCalledTimes(1)
  } finally {
    warn.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadIdeaPromptInstruction strips frontmatter and returns the body when the file is present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-idea-prompt-'))
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined as never)
  try {
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await writeFile(
      join(dir, IDEA_PROMPT_PATH),
      '---\ndescription: A custom operator instruction\n---\n\nCustom instruction body.\n',
    )
    await withLibraryDir(dir, async () => {
      const out = await loadIdeaPromptInstruction()
      expect(out).toBe('Custom instruction body.')
      expect(out).not.toContain('description:')
      expect(out).not.toContain('---')
    })
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadIdeaPromptInstruction falls back when the file exists but is blank, and warns once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-idea-prompt-'))
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined as never)
  try {
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await writeFile(join(dir, IDEA_PROMPT_PATH), '   \n\n  \n')
    await withLibraryDir(dir, async () => {
      const out = await loadIdeaPromptInstruction()
      expect(out).toBe(IDEA_PROMPT_INSTRUCTION_FALLBACK)
    })
    expect(warn).toHaveBeenCalledTimes(1)
  } finally {
    warn.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the fallback instruction is a real, usable prompt, not a one-line stub', () => {
  expect(IDEA_PROMPT_INSTRUCTION_FALLBACK.length).toBeGreaterThan(500)
})

// --- ideaPromptAnswerSchema ---------------------------------------------------

test('ideaPromptAnswerSchema accepts a well-formed answer', () => {
  const result = ideaPromptAnswerSchema.safeParse({
    title: 'Add CSV export',
    prompt: 'Build a streaming CSV export endpoint and wire it to a new toolbar button.',
    assumptions: ['Assumed the export button belongs in the existing toolbar next to Save.'],
  })
  expect(result.success).toBe(true)
})

test('ideaPromptAnswerSchema rejects an answer missing prompt', () => {
  const result = ideaPromptAnswerSchema.safeParse({
    title: 'Add CSV export',
    assumptions: [],
  })
  expect(result.success).toBe(false)
})

test('ideaPromptAnswerSchema rejects assumptions that is not an array', () => {
  const result = ideaPromptAnswerSchema.safeParse({
    title: 'Add CSV export',
    prompt: 'Build it.',
    assumptions: 'Assumed one thing.',
  })
  expect(result.success).toBe(false)
})
