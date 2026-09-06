// `parseStreamedMessage` as a pure function: what it accepts, what it drops,
// and that a drop is logged rather than silent — the boundary check that
// closes the hole `session-stream-malformed-frame.test.tsx` documents at the
// hook level (this file is what backs that fix).

import { afterEach, expect, spyOn, test } from 'bun:test'
import { parseStreamedMessage, streamedMessageSchema } from '../src/features/sessions/lib/streamed-message'
import { logger } from '../src/shared/lib/logger'

type Row = {
  id: string
  sessionId: string
  seq: number
  type: string
  parentToolUseId: string | null
  title: string | null
  pending: boolean
  payload: unknown
  createdAt: string
}

/** A raw Drizzle row, exactly as service.ts and session-run.worker.ts publish
 *  it: no `files` key at all (see message-cache.ts's own doc comment on the
 *  three publish sites not agreeing). */
const rawRow = (seq: number, o: Partial<Row> = {}): Row => ({
  id: 'm1',
  sessionId: 's1',
  seq,
  type: 'assistant',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: { message: { content: [{ type: 'text', text: 'hi' }] } },
  createdAt: '2026-09-04T10:00:00.000Z',
  ...o,
})

/** The mapped DTO shape, `files` included — what the file-announcement path
 *  (session-run.worker.ts's `messageDto`) publishes instead. */
const dtoRow = (seq: number) => ({
  ...rawRow(seq),
  files: [
    { id: 'f1', originalFilename: 'a.txt', mimeType: 'text/plain', sizeBytes: 10, status: 'ready' },
  ],
})

const frame = (message: unknown) => JSON.stringify({ message })

let warn: ReturnType<typeof spyOn>
afterEach(() => {
  warn?.mockRestore()
})

// --- what a valid frame produces ----------------------------------------------

test('a raw-row message (no files key) is accepted, unchanged', () => {
  const row = rawRow(5)
  const result = parseStreamedMessage(frame(row))
  expect(result).toEqual(row)
})

test('a DTO-shaped message (files included) is accepted', () => {
  const row = dtoRow(6)
  const result = parseStreamedMessage(frame(row))
  expect(result).toEqual(row)
})

test('a valid message logs nothing', () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  parseStreamedMessage(frame(rawRow(1)))
  expect(warn).not.toHaveBeenCalled()
})

test('an unknown extra key does not get the message rejected', () => {
  const result = parseStreamedMessage(frame({ ...rawRow(1), fromTheFuture: true }))
  expect(result?.seq).toBe(1)
})

// --- what gets dropped, and that dropping is logged ---------------------------

test('a non-JSON frame is dropped and logged, not thrown', () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  expect(() => parseStreamedMessage('not json at all')).not.toThrow()
  expect(parseStreamedMessage('not json at all')).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})

test('a frame with no message key at all is dropped and logged', () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  expect(parseStreamedMessage('{}')).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})

for (const value of [null, 0, '', false]) {
  test(`a falsy message value (${JSON.stringify(value)}) is dropped and logged`, () => {
    warn = spyOn(logger, 'warn').mockImplementation(() => {})
    expect(parseStreamedMessage(frame(value))).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
}

test('a message missing seq is dropped and logged — the exact shape that used to poison the cursor with NaN', () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  const { seq: _seq, ...withoutSeq } = rawRow(1)
  const result = parseStreamedMessage(frame(withoutSeq))
  expect(result).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})

for (const seq of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, '1']) {
  test(`a non-finite-integer seq (${String(seq)}) is dropped and logged`, () => {
    warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const result = parseStreamedMessage(frame({ ...rawRow(0), seq }))
    expect(result).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
}

test('a message that is a page envelope ({messages, hasOlder}) is dropped, not accepted verbatim', () => {
  // Previously the exact hole: nothing checked that `parsed.message` was a
  // single message rather than a whole page, so this landed in the tail
  // array as one nonsense element.
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  const result = parseStreamedMessage(frame({ messages: [rawRow(1)], hasOlder: false }))
  expect(result).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})

test('a message that is an array of messages is dropped, not nested as one element', () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  const result = parseStreamedMessage(frame([rawRow(1), rawRow(2)]))
  expect(result).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})

test('a bare string message is dropped, not appended as a string element', () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  const result = parseStreamedMessage(frame('hello'))
  expect(result).toBeUndefined()
  expect(warn).toHaveBeenCalled()
})

test('missing a scalar the transcript builder reads (title is absent rather than null) is dropped', () => {
  const { title: _title, ...withoutTitle } = rawRow(1)
  expect(parseStreamedMessage(frame(withoutTitle))).toBeUndefined()
})

// --- the schema directly, for the boundary values `parseStreamedMessage` delegates to ---

test('streamedMessageSchema treats files as optional', () => {
  const { files: _files, ...withoutFiles } = dtoRow(1)
  expect(streamedMessageSchema.safeParse(withoutFiles).success).toBe(true)
})

test('streamedMessageSchema requires seq to be present and a finite integer', () => {
  expect(streamedMessageSchema.safeParse(rawRow(3)).success).toBe(true)
  expect(streamedMessageSchema.safeParse({ ...rawRow(3), seq: Number.NaN }).success).toBe(false)
})
