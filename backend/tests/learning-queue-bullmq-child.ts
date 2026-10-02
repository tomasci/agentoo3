// Proves the hard queue requirement against REAL BullMQ on a REAL
// redis-server (nothing short of that can say whether a global concurrency
// cap actually holds — see tests/session-concurrency-bullmq-child.ts's own
// header for why): with the session-run queue's global concurrency at 1 and
// a `'turn'` job already occupying that one slot, a `'learning'` job added
// afterwards does not start until the turn job finishes — proving that a
// learning run shares the *exact same* queue-wide cap a session turn does,
// rather than any separate queue or worker ever executing it.
//
// The processor below distinguishes jobs purely by BullMQ job *name*
// (`'turn'` vs `'learning'`), the identical dispatch key
// queue/session-run.worker.ts's own `dispatchSessionRunJob` switches on —
// that function's *routing* ('learning' -> runLearning, anything else ->
// runTurn) is already unit-tested in isolation
// (tests/learning-worker-dispatch.test.ts); what only a real server can prove
// is this file's own subject: that both job names draw from the one queue's
// one concurrency counter.

import { randomUUID } from 'node:crypto'

const { Queue, Worker } = await import('bullmq')
const { default: IORedis } = await import('ioredis')
const { env } = await import('@/env')

const connection = () => new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })

const facts: Record<string, unknown> = {}

async function until(predicate: () => boolean, ms: number): Promise<number | undefined> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) return undefined
    await Bun.sleep(10)
  }
  return Date.now() - start
}

async function main() {
  const name = `learning-queue-proof-${randomUUID().slice(0, 8)}`
  const queue = new Queue(name, { connection: connection() })

  const entered: { name: string; id: string }[] = []
  const exited: { name: string; id: string }[] = []
  let inside = 0
  let peak = 0
  const gates = new Map<string, () => void>()

  const worker = new Worker(
    name,
    async (job) => {
      const id = job.id as string
      inside++
      peak = Math.max(peak, inside)
      entered.push({ name: job.name, id })
      await new Promise<void>((resolve) => gates.set(id, resolve))
      inside--
      exited.push({ name: job.name, id })
      return `done-${job.name}-${id}`
    },
    { connection: connection(), concurrency: 2, autorun: false },
  )
  const failed: string[] = []
  worker.on('failed', (job, error) => failed.push(`${job?.id}: ${error.message}`))

  await queue.setGlobalConcurrency(1)
  worker.run().catch(() => {})

  const release = async (id: string) => {
    await until(() => gates.has(id), 10_000)
    gates.get(id)?.()
    gates.delete(id)
  }

  // A 'turn' job occupies the one global slot.
  const turnJob = await queue.add('turn', { sessionId: 'sess-1' }, { jobId: 'turn-job' })
  const turnInMs = await until(() => entered.some((e) => e.id === turnJob.id), 10_000)

  // A 'learning' job, added while the turn job still holds the only slot.
  const learningJob = await queue.add(
    'learning',
    { learningRunId: 'run-1' },
    { jobId: 'learning-run-1' },
  )
  await Bun.sleep(1500)
  const learningEnteredWhileTurnRunning = entered.some((e) => e.id === learningJob.id)

  // Release the turn job; only now should the learning job be allowed in.
  await release(turnJob.id as string)
  const learningInMs = await until(() => entered.some((e) => e.id === learningJob.id), 10_000)
  await release(learningJob.id as string)
  await until(() => exited.length === 2, 10_000)

  facts.proof = {
    turnIn: turnInMs !== undefined,
    learningEnteredWhileTurnRunning,
    learningInAfterRelease: learningInMs !== undefined,
    peak,
    enteredOrder: entered.map((e) => e.name),
    exitedOrder: exited.map((e) => e.name),
    failed,
  }

  await worker.close()
  await queue.close()
}

main()
  .then(() => {
    console.log(`__FACTS__${JSON.stringify(facts)}`)
    process.exit(0)
  })
  .catch((error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    process.exit(1)
  })
