import { expect, test } from 'bun:test'
import {
  composeProjectLabelFilter,
  composeProjectName,
  containerName,
  imageReference,
  managedLabels,
  projectLabelFilter,
} from '../src/features/docker/names'

test('compose project name is agentoo-<slug>', () => {
  expect(composeProjectName('demo')).toBe('agentoo-demo')
})

test('container name for the plain-Dockerfile path is agentoo-<slug>', () => {
  expect(containerName('demo')).toBe('agentoo-demo')
})

test('image reference is agentoo/<slug>:latest', () => {
  expect(imageReference('demo')).toBe('agentoo/demo:latest')
})

test('managed labels carry both the project and the managed marker', () => {
  expect(managedLabels('demo')).toEqual(['com.agentoo.project=demo', 'com.agentoo.managed=1'])
})

test('label filters are usable directly as --filter values', () => {
  expect(projectLabelFilter('demo')).toBe('label=com.agentoo.project=demo')
  expect(composeProjectLabelFilter('demo')).toBe('label=com.docker.compose.project=agentoo-demo')
})

test('a slug that is not [a-z0-9-] is refused rather than silently used', () => {
  expect(() => composeProjectName('Demo!')).toThrow()
  expect(() => containerName('../etc')).toThrow()
  expect(() => imageReference('')).toThrow()
  expect(() => managedLabels('has spaces')).toThrow()
})

test('every slug toSlug() can actually produce is accepted', () => {
  // toSlug() (lib/paths.ts) yields [a-z0-9-]{1,48}, no leading/trailing dash.
  // Belt-and-braces: these must never throw.
  for (const slug of ['a', 'project', 'my-project-2', 'a'.repeat(48), 'x-y-z']) {
    expect(() => composeProjectName(slug)).not.toThrow()
  }
})
