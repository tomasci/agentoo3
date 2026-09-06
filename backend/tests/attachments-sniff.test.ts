import { expect, test } from 'bun:test'
import './setup-env'
import { sniff } from '../src/features/attachments/sniff'

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (s: string) => new TextEncoder().encode(s)

test('sniffs PNG by magic number regardless of extension', () => {
  const head = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
  expect(sniff(head, 'whatever.bin').mimeType).toBe('image/png')
})

test('sniffs JPEG', () => {
  expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0), 'x').mimeType).toBe('image/jpeg')
})

test('sniffs GIF87a and GIF89a', () => {
  expect(sniff(text('GIF87a...'), 'x').mimeType).toBe('image/gif')
  expect(sniff(text('GIF89a...'), 'x').mimeType).toBe('image/gif')
})

test('sniffs WEBP (RIFF....WEBP)', () => {
  const head = new Uint8Array([...text('RIFF'), 0, 0, 0, 0, ...text('WEBP')])
  expect(sniff(head, 'x').mimeType).toBe('image/webp')
})

test('sniffs PDF', () => {
  expect(sniff(text('%PDF-1.7\n...'), 'x').mimeType).toBe('application/pdf')
})

test('rejects binary with no magic number match', () => {
  const head = bytes(0x7f, 0x45, 0x4c, 0x46, 1, 2, 0, 3) // ELF-ish, contains a NUL
  const result = sniff(head, 'a.out')
  expect(result.ok).toBe(false)
})

test('rejects invalid UTF-8 with no magic number match', () => {
  const head = bytes(0xff, 0xfe, 0xfd, 0xfc)
  expect(sniff(head, 'mystery').ok).toBe(false)
})

test('text with .json extension parses to application/json', () => {
  expect(sniff(text('{"a":1}'), 'data.json').mimeType).toBe('application/json')
})

test('text with .json extension that fails to parse falls back to text/plain', () => {
  // Simulates a head that is a truncated prefix of a much larger JSON file.
  expect(sniff(text('{"a": [1, 2, '), 'data.json').mimeType).toBe('text/plain')
})

test('.csv, .md, .yaml/.yml map to their subtypes; everything else (including .log) is text/plain', () => {
  expect(sniff(text('a,b,c'), 'x.csv').mimeType).toBe('text/csv')
  expect(sniff(text('# hi'), 'x.md').mimeType).toBe('text/markdown')
  expect(sniff(text('a: 1'), 'x.yaml').mimeType).toBe('application/yaml')
  expect(sniff(text('a: 1'), 'x.yml').mimeType).toBe('application/yaml')
  expect(sniff(text('a trace'), 'x.log').mimeType).toBe('text/plain')
  expect(sniff(text('no extension'), 'noext').mimeType).toBe('text/plain')
})

test('empty file is accepted as text/plain', () => {
  expect(sniff(new Uint8Array(0), 'empty.txt')).toEqual({ ok: true, mimeType: 'text/plain' })
})
