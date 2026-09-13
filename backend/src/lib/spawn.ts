// Shared discipline for reading a spawned child process's stdout/stderr
// without hanging on a grandchild that inherited the pipe.
//
// Extracted out of git.ts, which first needed this for `ssh` (a grandchild of
// `git` over the ssh transport): `new Response(stream).text()` only resolves
// on EOF, and if that grandchild is stuck — mid handshake against a peer that
// accepted the connection and never sent a byte, say — it keeps the pipe's
// write end open indefinitely, and the read waits right along with it, even
// after the process we actually spawned has exited and been reaped. Anything
// else in this codebase that spawns a long-lived CLI (docker, tailscale) hits
// the identical shape and gets it from here rather than a second, slightly
// different copy of the same subtlety.

/** `setTimeout` as a promise, for racing against a read that may never settle. */
export function sleep(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function noop() {}

/**
 * How long to keep draining a pipe after the process that owned it has
 * already been reaped. Small on purpose: everything worth reading in this
 * window is already sitting in the OS pipe buffer (the process is dead, so
 * nothing new is coming from it), the only question is whether a surviving
 * grandchild happens to still be holding the write end open. This is not
 * "wait for the child to notice it should give up" — that can take up to its
 * own connect timeout, or forever — it is "stop pretending we will ever see
 * EOF".
 */
export const DRAIN_GRACE_MS = 300

/**
 * Read a spawned process's stream to EOF — except once the process itself has
 * exited, from which point whatever is left in the OS pipe buffer is drained
 * for at most `graceMs` longer and then abandoned.
 *
 * This exists because `Bun.spawn`'s `timeout` SIGKILLs only the process it
 * directly spawned. A process can fork a helper of its own that inherits its
 * stdout/stderr file descriptors — a grandchild from this process's point of
 * view — and killing the direct child does not touch it. `exited` still
 * resolves on schedule regardless, because Bun reaps the process it actually
 * spawned no matter what that process forked, which is what makes it a
 * reliable clock here and not just another thing that might hang.
 *
 * Reading starts immediately and unconditionally — not only once the process
 * has exited — because a command that writes more than one pipe buffer's
 * worth of output would otherwise block forever on a full buffer while this
 * function waited for it to finish first. That is a deadlock this must not
 * reintroduce, not a timeout.
 */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
  graceMs = DRAIN_GRACE_MS,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''

  // Resolves graceMs after the process is reaped — not a moment before, which
  // is what lets a legitimately slow command with no timeout at all read to
  // completion undisturbed. Built once, as a single promise, and raced against
  // every read below rather than checked-then-awaited per iteration: a read
  // already in flight when the process dies is exactly the read that needs to
  // be interrupted, and a check made only at the top of the loop is too late
  // for a read that started before the deadline existed and is still pending
  // when it arrives. Once this resolves, every subsequent race against it also
  // resolves immediately, which is what ends the loop.
  const drainDeadline = exited.then(() => sleep(graceMs))

  while (true) {
    // Caught here, not left to reject: cancelling the reader below can reject
    // a read that is still in flight, and that must not become an unhandled
    // rejection just because this specific attempt lost the race it is in.
    const read = reader.read().catch(() => ({ done: true as const, value: undefined }))
    const chunk = await Promise.race([read, drainDeadline])
    if (chunk === undefined || chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }

  // Releases our side of the stream. The underlying fd may still be held open
  // by a grandchild we never had a handle on — that is a leak in the orphaned
  // process, not in this process, and outside what a pipe reader can fix.
  reader.cancel().catch(noop)
  return text
}
