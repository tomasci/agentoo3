import { expect, test } from 'bun:test'
import { assembleHosts, type NetworkInterfacesInput } from '../src/features/docker/hosts'

const NO_TAILSCALE = { dnsName: null, ip: null }

test('loopback is always present, even with nothing else', () => {
  const hosts = assembleHosts({ interfaces: {}, tailscale: NO_TAILSCALE })
  expect(hosts).toEqual([{ kind: 'loopback', label: 'localhost', host: '127.0.0.1' }])
})

test('tailscale DNS name and IP both appear, DNS first, dot stripped', () => {
  const hosts = assembleHosts({
    interfaces: {},
    tailscale: { dnsName: 'my-box.taild9ed7f.ts.net', ip: '100.93.193.37' },
  })
  expect(hosts).toEqual([
    { kind: 'tailscale', label: 'Tailscale', host: 'my-box.taild9ed7f.ts.net' },
    { kind: 'tailscale', label: 'Tailscale (IP)', host: '100.93.193.37' },
    { kind: 'loopback', label: 'localhost', host: '127.0.0.1' },
  ])
})

test('an ordinary LAN interface is included', () => {
  const interfaces: NetworkInterfacesInput = {
    eth0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
  }
  const hosts = assembleHosts({ interfaces, tailscale: NO_TAILSCALE })
  expect(hosts).toContainEqual({ kind: 'lan', label: 'eth0', host: '192.168.1.50' })
})

test('internal addresses (127.0.0.1 on lo) are excluded from the lan pass', () => {
  const interfaces: NetworkInterfacesInput = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  }
  const hosts = assembleHosts({ interfaces, tailscale: NO_TAILSCALE })
  expect(hosts.filter((h) => h.kind === 'lan')).toEqual([])
})

test('docker0, br-*, and veth* interfaces are excluded — pure noise, unreachable from a browser', () => {
  const interfaces: NetworkInterfacesInput = {
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    'br-abc123': [{ address: '172.18.0.1', family: 'IPv4', internal: false }],
    veth1234: [{ address: '172.19.0.1', family: 'IPv4', internal: false }],
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  }
  const hosts = assembleHosts({ interfaces, tailscale: NO_TAILSCALE })
  expect(hosts.filter((h) => h.kind === 'lan')).toEqual([{ kind: 'lan', label: 'eth0', host: '10.0.0.5' }])
})

test('IPv6 addresses are excluded from the lan pass', () => {
  const interfaces: NetworkInterfacesInput = {
    eth0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '10.0.0.5', family: 'IPv4', internal: false },
    ],
  }
  const hosts = assembleHosts({ interfaces, tailscale: NO_TAILSCALE })
  expect(hosts.filter((h) => h.kind === 'lan')).toEqual([{ kind: 'lan', label: 'eth0', host: '10.0.0.5' }])
})

test('a LAN address identical to the tailscale IP is deduped, not listed twice', () => {
  const interfaces: NetworkInterfacesInput = {
    tailscale0: [{ address: '100.93.193.37', family: 'IPv4', internal: false }],
  }
  const hosts = assembleHosts({
    interfaces,
    tailscale: { dnsName: null, ip: '100.93.193.37' },
  })
  expect(hosts.filter((h) => h.host === '100.93.193.37')).toHaveLength(1)
})

test('order is tailscale, then lan, then loopback', () => {
  const interfaces: NetworkInterfacesInput = {
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  }
  const hosts = assembleHosts({
    interfaces,
    tailscale: { dnsName: 'box.ts.net', ip: '100.1.2.3' },
  })
  expect(hosts.map((h) => h.kind)).toEqual(['tailscale', 'tailscale', 'lan', 'loopback'])
})

test('several LAN interfaces with several addresses each are all included', () => {
  const interfaces: NetworkInterfacesInput = {
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    wlan0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  }
  const hosts = assembleHosts({ interfaces, tailscale: NO_TAILSCALE })
  expect(hosts.filter((h) => h.kind === 'lan')).toEqual([
    { kind: 'lan', label: 'eth0', host: '10.0.0.5' },
    { kind: 'lan', label: 'wlan0', host: '192.168.1.20' },
  ])
})
