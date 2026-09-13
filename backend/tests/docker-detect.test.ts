import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { detectProjectDocker } from '../src/features/docker/detect'

const dirs: string[] = []
async function tempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-docker-detect-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

test('a project with neither file reports both as absent', async () => {
  const dir = await tempProjectDir()
  const result = await detectProjectDocker(dir)
  expect(result).toEqual({
    hasCompose: false,
    hasDockerfile: false,
    composeFile: null,
    composeOverrideFile: null,
    dockerfile: null,
  })
})

test('compose.yaml is preferred over every other compose basename', async () => {
  const dir = await tempProjectDir()
  await writeFile(join(dir, 'compose.yaml'), '')
  await writeFile(join(dir, 'compose.yml'), '')
  await writeFile(join(dir, 'docker-compose.yaml'), '')
  await writeFile(join(dir, 'docker-compose.yml'), '')
  const result = await detectProjectDocker(dir)
  expect(result.composeFile).toBe('compose.yaml')
})

test('precedence falls through in order when earlier names are missing', async () => {
  const dir = await tempProjectDir()
  await writeFile(join(dir, 'docker-compose.yaml'), '')
  await writeFile(join(dir, 'docker-compose.yml'), '')
  const result = await detectProjectDocker(dir)
  expect(result.composeFile).toBe('docker-compose.yaml')
})

test('an override is only looked for once a base file is found, and matches its family', async () => {
  const dir = await tempProjectDir()
  await writeFile(join(dir, 'docker-compose.yml'), '')
  // Wrong family: must not be picked up for a docker-compose.* base.
  await writeFile(join(dir, 'compose.override.yaml'), '')
  const result = await detectProjectDocker(dir)
  expect(result.composeFile).toBe('docker-compose.yml')
  expect(result.composeOverrideFile).toBeNull()

  await writeFile(join(dir, 'docker-compose.override.yml'), '')
  const result2 = await detectProjectDocker(dir)
  expect(result2.composeOverrideFile).toBe('docker-compose.override.yml')
})

test('override precedence: .yaml before .yml, matching the base family', async () => {
  const dir = await tempProjectDir()
  await writeFile(join(dir, 'compose.yaml'), '')
  await writeFile(join(dir, 'compose.override.yml'), '')
  await writeFile(join(dir, 'compose.override.yaml'), '')
  const result = await detectProjectDocker(dir)
  expect(result.composeOverrideFile).toBe('compose.override.yaml')
})

test('a Dockerfile is detected independently of compose', async () => {
  const dir = await tempProjectDir()
  await writeFile(join(dir, 'Dockerfile'), 'FROM node\n')
  const result = await detectProjectDocker(dir)
  expect(result.hasDockerfile).toBe(true)
  expect(result.dockerfile).toBe('Dockerfile')
  expect(result.hasCompose).toBe(false)
})

test('a directory named like the file is not mistaken for it', async () => {
  const dir = await tempProjectDir()
  await mkdir(join(dir, 'Dockerfile'))
  const result = await detectProjectDocker(dir)
  expect(result.hasDockerfile).toBe(false)
})

test('both compose and a Dockerfile can be detected on the same project', async () => {
  const dir = await tempProjectDir()
  await writeFile(join(dir, 'compose.yaml'), '')
  await writeFile(join(dir, 'Dockerfile'), 'FROM node\n')
  const result = await detectProjectDocker(dir)
  expect(result.hasCompose).toBe(true)
  expect(result.hasDockerfile).toBe(true)
})

test('a nonexistent project path degrades to "nothing detected" rather than throwing', async () => {
  const result = await detectProjectDocker('/nonexistent-agentoo-docker-detect-path')
  expect(result.hasCompose).toBe(false)
  expect(result.hasDockerfile).toBe(false)
})
