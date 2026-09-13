// Pure text parsing of a Dockerfile's own EXPOSE directives — no docker CLI
// involved. This only ever runs *before* an image exists; once one does, the
// image itself is the truth (see inspect.ts's `inspectImage`, which wins over
// this when both are known — an EXPOSE a later commit removed but the image
// was never rebuilt against must not keep advertising a port nothing binds).

export interface DockerPort {
  containerPort: number
  protocol: 'tcp' | 'udp'
}

const EXPOSE_LINE = /^\s*EXPOSE\s+(.+)$/i
const PORT_TOKEN = /^(\d{1,5})(?:\/(tcp|udp))?$/i

/**
 * `EXPOSE <port>[/<proto>] ...`, possibly several per line and several
 * EXPOSE lines in one file. Deliberately line-oriented, not a full Dockerfile
 * parser: EXPOSE takes no line-continuation or ARG-style substitution this
 * project needs to resolve, and a token containing `$` (`EXPOSE ${PORT}`) is
 * skipped rather than guessed at — a guess here would tell a user their app
 * is reachable on a port that may not be the one the build actually resolves.
 */
export function parseExposedPorts(dockerfileText: string): DockerPort[] {
  const seen = new Set<string>()
  const ports: DockerPort[] = []

  for (const line of dockerfileText.split(/\r\n|\n/)) {
    const match = line.match(EXPOSE_LINE)
    if (!match?.[1]) continue

    for (const token of match[1].trim().split(/\s+/)) {
      if (token.includes('$')) continue
      const parsed = token.match(PORT_TOKEN)
      if (!parsed?.[1]) continue

      const containerPort = Number(parsed[1])
      if (containerPort < 1 || containerPort > 65535) continue
      const protocol = parsed[2]?.toLowerCase() === 'udp' ? 'udp' : 'tcp'

      const key = `${containerPort}/${protocol}`
      if (seen.has(key)) continue
      seen.add(key)
      ports.push({ containerPort, protocol })
    }
  }

  return ports
}
