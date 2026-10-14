import type { Conflict, DeadLetter, Row, SyncState, SyncStore, SyncTx } from "./types.js"

interface Data {
  rows: Map<string, Row>
  conflicts: Conflict[]
  deadLetters: DeadLetter[]
  state: SyncState
}

const empty = (): Data => ({ rows: new Map(), conflicts: [], deadLetters: [], state: { cursor: null, maxSeen: null, watermark: null } })

/** In-memory store for tests and trying things out. Transactions are copy-on-write, so a failed one changes nothing. */
export function memoryStore(): SyncStore & { /** Simulates the owning app editing a synced row directly. */ localEdit(sync: string, id: string, data: Record<string, unknown>): void } {
  const syncs = new Map<string, Data>()
  const of = (sync: string) => {
    let d = syncs.get(sync)
    if (!d) syncs.set(sync, (d = empty()))
    return d
  }
  return {
    async getState(sync) {
      return { ...of(sync).state }
    },
    async transaction(sync, fn) {
      const live = of(sync)
      const work: Data = { rows: new Map([...live.rows].map(([k, v]) => [k, structuredClone(v)])), conflicts: structuredClone(live.conflicts), deadLetters: structuredClone(live.deadLetters), state: { ...live.state } }
      const tx: SyncTx = {
        getRow: (id) => work.rows.get(id),
        putRow: (row) => void work.rows.set(row.id, structuredClone(row)),
        addConflict: (c) => void work.conflicts.push(c),
        addDeadLetter: (l) => void work.deadLetters.push(l),
        setState: (s) => void (work.state = { ...s }),
      }
      const result = await fn(tx)
      syncs.set(sync, work) // commit: only reached when fn did not throw
      return result
    },
    async getRow(sync, id) {
      return of(sync).rows.get(id)
    },
    async listConflicts(sync) {
      return [...of(sync).conflicts]
    },
    async listDeadLetters(sync) {
      return [...of(sync).deadLetters]
    },
    async removeDeadLetters(sync, indexes) {
      const d = of(sync)
      const drop = new Set(indexes)
      d.deadLetters = d.deadLetters.filter((_, i) => !drop.has(i))
    },
    localEdit(sync, id, data) {
      const row = of(sync).rows.get(id)
      if (!row) throw new Error(`no row ${id}`)
      row.data = structuredClone(data)
    },
  }
}
