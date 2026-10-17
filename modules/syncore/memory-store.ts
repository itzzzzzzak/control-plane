import { randomUUID } from "node:crypto"
import { LeaseLostError, type Conflict, type DeadLetter, type Row, type SyncLease, type SyncState, type SyncStore, type SyncTx } from "./types.js"

interface Data {
  rows: Map<string, Row>
  conflicts: Conflict[]
  deadLetters: DeadLetter[]
  state: SyncState
  epoch: bigint
  lease: SyncLease | null
}
const empty = (): Data => ({ rows: new Map(), conflicts: [], deadLetters: [], state: { cursor: null, maxSeen: null, watermark: null }, epoch: 0n, lease: null })

/** Test store. Serializes each sync's transactions and fences expired/stale leases. */
export function memoryStore(clock: () => number = Date.now): SyncStore & {
  localEdit(sync: string, id: string, data: Record<string, unknown>): void
} {
  const syncs = new Map<string, Data>()
  const queues = new Map<string, Promise<void>>()
  const of = (sync: string): Data => {
    let d = syncs.get(sync)
    if (!d) { d = empty(); syncs.set(sync, d) }
    return d
  }
  const valid = (lease: SyncLease): boolean => {
    const d = of(lease.sync)
    return d.lease !== null && d.lease.token === lease.token &&
      d.lease.epoch === lease.epoch && d.lease.expiresAt.getTime() > clock()
  }
  const check = (lease: SyncLease): void => { if (!valid(lease)) throw new LeaseLostError() }
  const ttlValid = (ttl: number) => Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 86_400_000
  async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prior = queues.get(name) ?? Promise.resolve()
    let unblock!: () => void
    const current = new Promise<void>((resolve) => { unblock = resolve })
    queues.set(name, current)
    await prior
    try { return await fn() } finally {
      if (queues.get(name) === current) queues.delete(name)
      unblock()
    }
  }

  return {
    acquire: (sync, ttlMs) => exclusive(sync, async () => {
      if (!ttlValid(ttlMs)) throw new RangeError("invalid lease ttl")
      const d = of(sync)
      if (d.lease && d.lease.expiresAt.getTime() > clock()) return null
      const epoch = ++d.epoch
      const lease = { sync, token: randomUUID(), epoch, expiresAt: new Date(clock() + ttlMs) }
      d.lease = lease
      return { ...lease }
    }),
    renew: (lease, ttlMs) => exclusive(lease.sync, async () => {
      if (!ttlValid(ttlMs)) throw new RangeError("invalid lease ttl")
      if (!valid(lease)) return null
      const next = { ...lease, expiresAt: new Date(clock() + ttlMs) }
      of(lease.sync).lease = next
      return { ...next }
    }),
    release: (lease) => exclusive(lease.sync, async () => {
      if (!valid(lease)) return false
      of(lease.sync).lease = null
      return true
    }),
    async getState(sync) { return { ...of(sync).state } },
    transaction: (sync, lease, fn) => exclusive(sync, async () => {
      if (lease.sync !== sync) throw new LeaseLostError()
      check(lease)
      const live = of(sync)
      const work: Data = {
        rows: new Map([...live.rows].map(([k, v]) => [k, structuredClone(v)])),
        conflicts: structuredClone(live.conflicts),
        deadLetters: structuredClone(live.deadLetters),
        state: { ...live.state }, epoch: live.epoch, lease: live.lease,
      }
      const tx: SyncTx = {
        getRow: (id) => work.rows.get(id),
        putRow: (row) => void work.rows.set(row.id, structuredClone(row)),
        addConflict: (c) => void work.conflicts.push(structuredClone(c)),
        addDeadLetter: (l) => void work.deadLetters.push(structuredClone(l)),
        setState: (s) => void (work.state = { ...s }),
      }
      const result = await fn(tx)
      check(lease) // verify *after* async work and before commit, while serialized
      live.rows = work.rows
      live.conflicts = work.conflicts
      live.deadLetters = work.deadLetters
      live.state = work.state
      return result
    }),
    async getRow(sync, id) { const r = of(sync).rows.get(id); return r && structuredClone(r) },
    async listConflicts(sync) { return structuredClone(of(sync).conflicts) },
    async listDeadLetters(sync) { return structuredClone(of(sync).deadLetters) },
    removeDeadLetters: (sync, lease, indexes) => exclusive(sync, async () => {
      if (lease.sync !== sync) throw new LeaseLostError()
      check(lease)
      const d = of(sync)
      const drop = new Set(indexes)
      d.deadLetters = d.deadLetters.filter((_, i) => !drop.has(i))
    }),
    localEdit(sync, id, data) {
      const row = of(sync).rows.get(id)
      if (!row) throw new Error(`no row ${id}`)
      row.data = structuredClone(data)
    },
  }
}
