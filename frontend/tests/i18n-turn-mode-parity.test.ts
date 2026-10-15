// The Code / Q&A switch's i18n: `sessions.turnMode.*` exists in both locales
// with the same set of keys, the Russian is actually Russian, and the files
// that render them really reference each key — same approach as
// tests/i18n-composer-mode-parity.test.ts.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

const NEW_KEYS = [
  'sessions.turnMode.label',
  'sessions.turnMode.code',
  'sessions.turnMode.qa',
  'sessions.turnMode.codeTooltip',
  'sessions.turnMode.qaTooltip',
] as const

const source = (file: string) =>
  readFileSync(join(import.meta.dir, '../src/features/sessions/components', file), 'utf8')
const COMPOSER = source('composer.tsx')
const TRANSCRIPT = source('transcript.tsx')

test('every new key is a non-empty string in en.json and ru.json', () => {
  const problems: string[] = []
  for (const key of NEW_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') problems.push(`${locale}:${key}`)
    }
  }
  expect(problems).toEqual([])
})

test('en.json and ru.json hold exactly the same keys under sessions.turnMode', () => {
  expect(Object.keys(ru.sessions.turnMode).sort()).toEqual(Object.keys(en.sessions.turnMode).sort())
  expect(Object.keys(en.sessions.turnMode).sort()).toEqual(
    NEW_KEYS.map((key) => key.split('.')[2] ?? '').sort(),
  )
})

test('no ru value is a copy of the en one', () => {
  expect(NEW_KEYS.filter((key) => lookup(en, key) === lookup(ru, key))).toEqual([])
})

test('every ru value is written in Cyrillic', () => {
  expect(NEW_KEYS.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))).toEqual([])
})

test('the visible labels are the ones the switch is specified with', () => {
  expect(en.sessions.turnMode.code).toBe('Code')
  expect(en.sessions.turnMode.qa).toBe('Q&A')
  expect(en.sessions.turnMode.label).toBe('Agent mode')
  expect(ru.sessions.turnMode.code).toBe('Код')
  expect(ru.sessions.turnMode.qa).toBe('Вопрос')
  expect(ru.sessions.turnMode.label).toBe('Режим агента')
})

test('the two modes have different labels and different tooltips, in both locales', () => {
  for (const bundle of [en, ru]) {
    expect(bundle.sessions.turnMode.code).not.toBe(bundle.sessions.turnMode.qa)
    expect(bundle.sessions.turnMode.codeTooltip).not.toBe(bundle.sessions.turnMode.qaTooltip)
  }
})

test('composer.tsx references each key, and transcript.tsx the badge label', () => {
  expect(NEW_KEYS.filter((key) => !COMPOSER.includes(`'${key}'`))).toEqual([])
  expect(TRANSCRIPT.includes("'sessions.turnMode.qa'")).toBe(true)
})
