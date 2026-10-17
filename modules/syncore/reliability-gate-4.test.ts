import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { memoryStore, postgresStore, runSync, type RunOptions, type SyncStore } from './index.js'
const url = process.env.SYNCORE_TEST_DATABASE_URL
const at = (n: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, n)).toISOString()
const rec = (id: string, n: number) => ({ id, modifiedAt: at(n), data: { id } })
// Deliberately dynamic options allow an executable RED contract before RunOptions evolves.
const run = (options: RunOptions, lookbackMs: number) => runSync({ ...options, lookbackMs } as RunOptions)

for (const backend of ['memory', 'postgres'] as const) {
  test(`Gate 4 ${backend}: late arrivals and immutable resumed query`, { skip: backend === 'postgres' && !url, timeout: 15000 }, async t => {
    let pool = backend === 'postgres' ? new Pool({ connectionString: url }) : null
    t.after(async () => { await pool?.end() })
    let store: SyncStore = pool ? postgresStore(pool) : memoryStore()
    const name = randomUUID()
    await runSync({ name, store, source: { async fetchPage() { return { records: [rec('boundary', 100)], nextCursor: null } } } })
    const partial = await run({ name, store, source: { async fetchPage(args) {
      assert.equal(args.since, at(90))
      if (args.cursor) throw new Error('offline between pages')
      return { records: [rec('late', 95), rec('boundary', 100)], nextCursor: 'resume' }
    } } }, 10000)
    assert.equal(partial.status, 'stopped')
    assert.equal(partial.stats.created, 1)
    assert.ok(await store.getRow(name, 'late'))
    if (pool) {
      const saved = (await pool.query('SELECT run_since,query_since_set FROM syncore_state WHERE sync_name=$1', [name])).rows[0]
      assert.equal(saved.run_since, at(90))
      assert.equal(saved.query_since_set, true)
      await pool.end()
      pool = new Pool({ connectionString: url })
      store = postgresStore(pool)
    }
    const resumed = await run({ name, store, source: { async fetchPage(args) {
      assert.equal(args.cursor, 'resume')
      assert.equal(args.since, at(90), 'configuration change must not change cursor query')
      return { records: [rec('also-late', 96)], nextCursor: null }
    } } }, 60000)
    assert.equal(resumed.status, 'completed')
    assert.equal((await store.getState(name)).watermark, at(100))
    assert.equal(Object.hasOwn(await store.getState(name), 'runSince'), false)
    if (pool) {
      const saved = (await pool.query('SELECT run_since,query_since_set FROM syncore_state WHERE sync_name=$1', [name])).rows[0]
      assert.equal(saved.run_since, null)
      assert.equal(saved.query_since_set, false)
    }
    // Legacy checkpoints had no query-bound marker; preserve their original since.
    const lease = (await store.acquire(name, 10000))!
    await store.transaction(name, lease, tx => tx.setState({ cursor: 'legacy', maxSeen: at(100), watermark: at(100) }))
    await store.release(lease)
    assert.equal((await run({ name, store, source: { async fetchPage(args) {
      assert.equal(args.since, at(100)); return { records: [], nextCursor: null }
    } } }, 60000)).status, 'completed')
    // A full run's intentionally null boundary stays null after restart/config changes.
    const full = randomUUID()
    await run({ name: full, store, source: { async fetchPage(args) {
      assert.equal(args.since, null)
      if (args.cursor) throw new Error('partial full run')
      return { records: [rec('full', 100)], nextCursor: 'full-next' }
    } } }, 0)
    assert.equal((await run({ name: full, store, source: { async fetchPage(args) {
      assert.equal(args.since, null); return { records: [], nextCursor: null }
    } } }, 86400000)).status, 'completed')
  })
}

test('Gate 4 invalid lookback is rejected before any ownership or source calls', async () => {
  const store = memoryStore()
  let acquisitions = 0
  const acquire = store.acquire.bind(store)
  store.acquire = async (...args) => { acquisitions++; return acquire(...args) }
  for (const lookback of [-1, NaN, Infinity, 0.1, 86400001]) {
    await assert.rejects(run({ name: 'invalid', store, source: { async fetchPage() { throw new Error('source must not run') } } }, lookback), /lookback/)
  }
  assert.equal(acquisitions, 0)
})
