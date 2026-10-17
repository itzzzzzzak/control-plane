import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { memoryStore, postgresStore, runSync, replayDeadLetters, hashData, type SyncStore } from './index.js'
const url = process.env.SYNCORE_TEST_DATABASE_URL
const at = (n: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, n)).toISOString()
const rec = (id: string, n: number, value = 'source') => ({ id, modifiedAt: at(n), data: { value } })
const gone = (id: string, n: number) => ({ id, modifiedAt: at(n), deleted: true })
const deliver = (store: SyncStore, name: string, records: unknown[]) => runSync({ name, store, source: { async fetchPage() { return { records, nextCursor: null } } } })

for (const backend of ['memory', 'postgres'] as const) {
  test(`Gate 3 ${backend}: revision and tombstone contract`, { skip: backend === 'postgres' && !url, timeout: 15000 }, async t => {
    const pool = backend === 'postgres' ? new Pool({ connectionString: url }) : null
    if (pool) t.after(() => pool.end())
    const store = pool ? postgresStore(pool) : memoryStore()
    const name = randomUUID()
    assert.equal((await deliver(store, name, [gone('unseen', 5)])).status, 'completed')
    assert.equal((await store.getRow(name, 'unseen'))?.deleted, true)
    await deliver(store, name, [rec('unseen', 4)])
    assert.equal((await store.getRow(name, 'unseen'))?.deleted, true)
    assert.equal((await store.getState(name)).watermark, at(5), 'stale pages cannot move the watermark backward')
    await deliver(store, name, [gone('unseen', 8)])
    assert.equal((await store.getRow(name, 'unseen'))?.sourceModifiedAt, at(8))
    await deliver(store, name, [rec('unseen', 7), rec('unseen', 8)])
    assert.equal((await store.getRow(name, 'unseen'))?.deleted, true)
    await deliver(store, name, [rec('unseen', 9)])
    assert.equal((await store.getRow(name, 'unseen'))?.deleted, false)
    // A tied delete is authoritative, including after source timestamp normalization.
    await deliver(store, name, [gone('unseen', 9)])
    assert.equal((await store.getRow(name, 'unseen'))?.deleted, true)

    await deliver(store, name, [rec('edited', 10)])
    const lease = (await store.acquire(name, 10000))!
    await store.transaction(name, lease, async tx => {
      const row = (await tx.getRow('edited'))!
      await tx.putRow({ ...row, data: { value: 'local' } })
    })
    await store.release(lease)
    const duplicate = await deliver(store, name, [{ ...rec('edited', 10), modifiedAt: '2026-10-17T05:30:10+05:30' }])
    assert.equal(duplicate.stats.conflicts, 0)
    assert.equal((await store.getRow(name, 'edited'))?.data.value, 'local')
    await deliver(store, name, [rec('edited', 11)]) // metadata-only source update
    assert.equal((await store.getRow(name, 'edited'))?.data.value, 'local')
    assert.equal((await store.getRow(name, 'edited'))?.sourceModifiedAt, at(11))
    await deliver(store, name, [rec('edited', 12, 'new-source')])
    assert.equal((await store.getRow(name, 'edited'))?.data.value, 'new-source')
    assert.equal((await store.listConflicts(name)).length, 1)
    assert.equal((await store.listConflicts(name))[0]?.overwritten.value, 'local')

    const before = await store.getState(name)
    const ambiguous = await deliver(store, name, [rec('must-rollback', 20), rec('edited', 12, 'ambiguous')])
    assert.equal(ambiguous.status, 'stopped')
    assert.match(ambiguous.error!, /ambiguous.*revision/i)
    assert.equal(ambiguous.stats.created, 0)
    assert.equal(await store.getRow(name, 'must-rollback'), undefined)
    assert.deepEqual(await store.getState(name), before)
    assert.equal((await store.getRow(name, 'edited'))?.data.value, 'new-source')
    assert.equal((await store.listConflicts(name)).length, 1)

    const owner = (await store.acquire(name, 10000))!
    await store.transaction(name, owner, tx => tx.addDeadLetter({ raw: rec('edited', 12, 'ambiguous'), reason: 'operator replay', at: at(20) }))
    await store.release(owner)
    await assert.rejects(replayDeadLetters({ name, store }), /ambiguous.*revision/i)
    assert.equal((await store.listDeadLetters(name)).length, 1)
    assert.equal((await store.getRow(name, 'edited'))?.baseHash, hashData({ value: 'new-source' }))
  })
}
