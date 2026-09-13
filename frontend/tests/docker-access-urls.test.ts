// Pure module, no DOM: `access-urls.ts` deliberately takes `browserHostname`
// as a plain argument rather than reading `window.location` itself, which is
// what lets every case below run as a plain function test — the component
// (access-urls.tsx) is the one place `window.location.hostname` is read.

import { expect, test } from 'bun:test'
import { buildAccessUrls, collectHosts, type ServerHost } from '../src/features/docker/lib/access-urls'
import type { DockerContainer } from '../src/features/docker/lib/state'

const container = (o: Partial<DockerContainer> & { id: string }): DockerContainer => ({
  shortId: o.id.slice(0, 12),
  name: o.id,
  service: null,
  image: 'app:latest',
  state: 'running',
  health: 'none',
  exitCode: null,
  createdAt: '2026-09-04T10:00:00.000Z',
  startedAt: '2026-09-04T10:00:01.000Z',
  finishedAt: null,
  ports: [],
  ...o,
})

const TAILSCALE: ServerHost = { kind: 'tailscale', label: 'Tailscale (my-box)', host: 'my-box.tailnet.ts.net' }
const LAN: ServerHost = { kind: 'lan', label: 'LAN', host: '192.168.1.20' }
const LOOPBACK: ServerHost = { kind: 'loopback', label: 'Loopback', host: '127.0.0.1' }

// --- collectHosts ------------------------------------------------------------

test('collectHosts appends the browser hostname last, labelled null', () => {
  const hosts = collectHosts([TAILSCALE, LAN], 'reader.example.com')
  expect(hosts).toEqual([
    { kind: 'tailscale', label: 'Tailscale (my-box)', host: 'my-box.tailnet.ts.net' },
    { kind: 'lan', label: 'LAN', host: '192.168.1.20' },
    { kind: 'browser', label: null, host: 'reader.example.com' },
  ])
})

test('collectHosts drops the browser hostname when it duplicates a server-reported one', () => {
  // The common case: this dashboard opened on the same box docker runs on.
  const hosts = collectHosts([LOOPBACK], '127.0.0.1')
  expect(hosts).toEqual([{ kind: 'loopback', label: 'Loopback', host: '127.0.0.1' }])
})

test('collectHosts drops a blank browser hostname rather than adding an empty entry', () => {
  expect(collectHosts([LAN], '')).toEqual([{ kind: 'lan', label: 'LAN', host: '192.168.1.20' }])
  expect(collectHosts([LAN], '   ')).toEqual([{ kind: 'lan', label: 'LAN', host: '192.168.1.20' }])
})

test('collectHosts with no server hosts at all still keeps the browser one', () => {
  expect(collectHosts([], 'reader.example.com')).toEqual([
    { kind: 'browser', label: null, host: 'reader.example.com' },
  ])
})

// --- buildAccessUrls ----------------------------------------------------------

test('one entry per running container port, crossed with every host', () => {
  const hosts = collectHosts([LAN], 'reader.example.com')
  const web = container({
    id: 'web1',
    ports: [{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }],
  })
  const entries = buildAccessUrls(hosts, [web])

  expect(entries).toHaveLength(2)
  expect(entries.map((e) => e.url).sort()).toEqual(
    ['http://192.168.1.20:8080', 'http://reader.example.com:8080'].sort(),
  )
  for (const entry of entries) {
    expect(entry.port).toBe(8080)
    expect(entry.protocol).toBe('tcp')
    expect(entry.containerName).toBe('web1')
  }
})

test('a stopped container publishes no access URL at all', () => {
  const hosts = collectHosts([LAN], 'reader.example.com')
  const stopped = container({
    id: 'web1',
    state: 'exited',
    ports: [{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }],
  })
  expect(buildAccessUrls(hosts, [stopped])).toEqual([])
})

test('a container with no published port produces nothing', () => {
  const hosts = collectHosts([LAN], 'reader.example.com')
  const bare = container({ id: 'web1', ports: [] })
  expect(buildAccessUrls(hosts, [bare])).toEqual([])
})

test('scheme is always http, never https, regardless of the port number', () => {
  const hosts = collectHosts([], 'reader.example.com')
  const web = container({
    id: 'web1',
    ports: [{ containerPort: 443, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8443 }],
  })
  const [entry] = buildAccessUrls(hosts, [web])
  expect(entry?.url).toBe('http://reader.example.com:8443')
})

test('a udp port gets an entry with no url — a browser cannot open a udp:// address', () => {
  const hosts = collectHosts([], 'reader.example.com')
  const dns = container({
    id: 'dns1',
    ports: [{ containerPort: 53, protocol: 'udp', hostIp: '0.0.0.0', hostPort: 5300 }],
  })
  const [entry] = buildAccessUrls(hosts, [dns])
  expect(entry?.url).toBeNull()
  expect(entry?.port).toBe(5300)
  expect(entry?.protocol).toBe('udp')
})

test('multiple running containers each contribute their own ports, across every host', () => {
  const hosts = collectHosts([LAN], 'reader.example.com')
  const web = container({
    id: 'web1',
    ports: [{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }],
  })
  const api = container({
    id: 'api1',
    ports: [{ containerPort: 3000, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 3000 }],
  })
  const entries = buildAccessUrls(hosts, [web, api])
  expect(entries).toHaveLength(4)
  expect(new Set(entries.map((e) => e.containerName))).toEqual(new Set(['web1', 'api1']))
})

test('entry keys are unique — safe for a React list key with no collisions', () => {
  const hosts = collectHosts([LAN, TAILSCALE], 'reader.example.com')
  const web = container({
    id: 'web1',
    ports: [
      { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 443, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8443 },
    ],
  })
  const entries = buildAccessUrls(hosts, [web])
  expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length)
})
