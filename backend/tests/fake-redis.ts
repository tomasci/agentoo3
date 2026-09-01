// Just enough RESP for ioredis's pub/sub: PING, INFO, HELLO, SUBSCRIBE,
// PUBLISH, QUIT.
//
// The event bus is the one piece of this that cannot be tested by reasoning
// about it — publish/subscribe either crosses a process boundary or it does
// not. There is no Redis in CI, so this stands in for one.
//
// ioredis 6 negotiates RESP3 (`HELLO 3`), which is why the handshake answers
// with a map and pushes are framed with `>` rather than `*`. Answering the
// handshake with an error instead makes ioredis treat it as fatal.
import { type Socket, listen } from 'bun'

type Conn = { subs: Set<string>; buf: string }

export function startFakeRedis(port: number) {
  const conns = new Map<Socket<Conn>, Conn>()

  const parse = (buf: string): { args: string[][]; rest: string } => {
    const args: string[][] = []
    let i = 0
    for (;;) {
      if (buf[i] !== '*') break
      const nlEnd = buf.indexOf('\r\n', i)
      if (nlEnd === -1) break
      const n = Number(buf.slice(i + 1, nlEnd))
      let j = nlEnd + 2
      const parts: string[] = []
      let ok = true
      for (let k = 0; k < n; k++) {
        if (buf[j] !== '$') { ok = false; break }
        const lenEnd = buf.indexOf('\r\n', j)
        if (lenEnd === -1) { ok = false; break }
        const len = Number(buf.slice(j + 1, lenEnd))
        const start = lenEnd + 2
        if (buf.length < start + len + 2) { ok = false; break }
        parts.push(buf.slice(start, start + len))
        j = start + len + 2
      }
      if (!ok) break
      args.push(parts)
      i = j
    }
    return { args, rest: buf.slice(i) }
  }

  const server = listen<Conn>({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(socket) {
        const state = { subs: new Set<string>(), buf: '' }
        socket.data = state
        conns.set(socket, state)
      },
      close(socket) { conns.delete(socket) },
      data(socket, chunk) {
        const state = socket.data
        state.buf += chunk.toString()
        const { args, rest } = parse(state.buf)
        state.buf = rest
        for (const parts of args) {
          const cmd = (parts[0] ?? '').toUpperCase()
          // Decline RESP3 so pushes stay in RESP2 `*3` form, which is all this
          // fake speaks. ioredis falls back cleanly on an error here.
          if (cmd === 'HELLO') {
            // ioredis 6 speaks RESP3, so answer the handshake with a map and
            // push messages with `>` rather than `*`.
            socket.write(
              '%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$5\r\n7.0.0\r\n' +
                '$5\r\nproto\r\n:3\r\n$2\r\nid\r\n:1\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n' +
                '$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n',
            )
          }
          else if (cmd === 'HSET') socket.write(':1\r\n')
          else if (cmd === 'PING') socket.write('+PONG\r\n')
          else if (cmd === 'INFO') {
            const body = '# Server\r\nredis_version:7.0.0\r\nredis_mode:standalone\r\n'
            socket.write(`$${body.length}\r\n${body}\r\n`)
          } else if (cmd === 'SUBSCRIBE') {
            for (const ch of parts.slice(1)) {
              state.subs.add(ch)
              socket.write(`>3\r\n$9\r\nsubscribe\r\n$${ch.length}\r\n${ch}\r\n:${state.subs.size}\r\n`)
            }
          } else if (cmd === 'PUBLISH') {
            const [, ch = '', payload = ''] = parts
            let n = 0
            for (const [other, st] of conns) {
              if (!st.subs.has(ch)) continue
              other.write(`>3\r\n$7\r\nmessage\r\n$${Buffer.byteLength(ch)}\r\n${ch}\r\n$${Buffer.byteLength(payload)}\r\n${payload}\r\n`)
              n++
            }
            socket.write(`:${n}\r\n`)
          } else if (cmd === 'QUIT') { socket.write('+OK\r\n'); socket.end() }
          else socket.write('+OK\r\n')
        }
      },
    },
  })
  return { stop: () => server.stop(true) }
}
