// Greedily packing session digests (features/learning/digest.ts) into batches
// for one review call each — pure and unit-tested (tests/learning-batching.
// test.ts), so the packing rule itself is checkable without a model call
// anywhere nearby.

export interface SessionDigest {
  sessionId: string
  text: string
}

/**
 * Packs `digests` into batches whose combined `text.length` stays at or under
 * `maxChars`, in the order given — greedy, not bin-packing: each digest is
 * added to the batch being built if it fits, else that batch closes and a new
 * one starts with this digest. A single digest at or over `maxChars` on its
 * own (digest.ts's own per-session cap bounds how large that can ever get)
 * still becomes a batch of exactly one, rather than being split or dropped:
 * there is nothing left to cut once digest.ts has already capped it.
 */
export function packBatches(digests: SessionDigest[], maxChars: number): SessionDigest[][] {
  const batches: SessionDigest[][] = []
  let current: SessionDigest[] = []
  let currentChars = 0

  const closeCurrent = () => {
    if (current.length > 0) batches.push(current)
    current = []
    currentChars = 0
  }

  for (const digest of digests) {
    if (digest.text.length >= maxChars) {
      closeCurrent()
      batches.push([digest])
      continue
    }
    if (current.length > 0 && currentChars + digest.text.length > maxChars) {
      closeCurrent()
    }
    current.push(digest)
    currentChars += digest.text.length
  }
  closeCurrent()

  return batches
}
