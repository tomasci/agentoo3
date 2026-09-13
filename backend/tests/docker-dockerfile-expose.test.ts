import { expect, test } from 'bun:test'
import { parseExposedPorts } from '../src/features/docker/dockerfile'

test('a single EXPOSE with no protocol defaults to tcp', () => {
  expect(parseExposedPorts('FROM node\nEXPOSE 3000\n')).toEqual([{ containerPort: 3000, protocol: 'tcp' }])
})

test('an explicit protocol is honoured', () => {
  expect(parseExposedPorts('EXPOSE 3000/udp')).toEqual([{ containerPort: 3000, protocol: 'udp' }])
})

test('several ports on one EXPOSE line', () => {
  expect(parseExposedPorts('EXPOSE 3000 8080/udp 9229')).toEqual([
    { containerPort: 3000, protocol: 'tcp' },
    { containerPort: 8080, protocol: 'udp' },
    { containerPort: 9229, protocol: 'tcp' },
  ])
})

test('several EXPOSE lines are all collected', () => {
  const text = 'FROM node\nEXPOSE 3000\nRUN echo hi\nEXPOSE 4000/udp\n'
  expect(parseExposedPorts(text)).toEqual([
    { containerPort: 3000, protocol: 'tcp' },
    { containerPort: 4000, protocol: 'udp' },
  ])
})

test('EXPOSE is case-insensitive, matching Dockerfile instruction rules', () => {
  expect(parseExposedPorts('expose 3000')).toEqual([{ containerPort: 3000, protocol: 'tcp' }])
})

test('unresolved interpolation is skipped, not guessed at', () => {
  expect(parseExposedPorts('EXPOSE ${PORT}')).toEqual([])
  expect(parseExposedPorts('EXPOSE 3000 ${PORT}')).toEqual([{ containerPort: 3000, protocol: 'tcp' }])
})

test('a duplicate port/protocol pair is only reported once', () => {
  expect(parseExposedPorts('EXPOSE 3000\nEXPOSE 3000')).toEqual([{ containerPort: 3000, protocol: 'tcp' }])
})

test('an out-of-range port number is rejected', () => {
  expect(parseExposedPorts('EXPOSE 70000')).toEqual([])
  expect(parseExposedPorts('EXPOSE 0')).toEqual([])
})

test('a line that only mentions EXPOSE in passing (a comment, a RUN) is not matched', () => {
  expect(parseExposedPorts('# EXPOSE 3000 in a comment\nRUN echo "EXPOSE 4000"\n')).toEqual([])
})

test('no EXPOSE at all is an empty list, not an error', () => {
  expect(parseExposedPorts('FROM node\nCOPY . .\nCMD ["node", "index.js"]\n')).toEqual([])
})

test('a garbage token amid valid ones is skipped, not fatal', () => {
  expect(parseExposedPorts('EXPOSE 3000 not-a-port 4000')).toEqual([
    { containerPort: 3000, protocol: 'tcp' },
    { containerPort: 4000, protocol: 'tcp' },
  ])
})
