import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { runSync, replayDeadLetters, hashData } from './index.js'
const url = process.env.SYNCORE_TEST_DATABASE_URL
const adapterPath = './' + 'postgres-store.js'
const at = '2026-10-17T00:00:00.000Z'
const row = (id: string) => ({ id, data: { name: id }, baseHash: hashData({ name: id }), sourceModifiedAt: at, deleted: false })

test('Gate 2 real PostgreSQL durability, fencing and rollback', { skip: !url, timeout: 20000 }, async (t) => {
  const { postgresStore } = await import(adapterPath)
  const pool = new Pool({ connectionString: url, max: 4 })
  const other = new Pool({ connectionString: url, max: 4 })
  t.after(async () => { await pool.end(); await other.end() })
  const store = postgresStore(pool)
  const second = postgresStore(other)
  const name = randomUUID()
  const claims = await Promise.all([store.acquire(name, 10000), second.acquire(name, 10000)])
  assert.equal(claims.filter(Boolean).length, 1)
  const lease = claims.find(Boolean)!
  await assert.rejects(store.transaction(name, lease, async (tx: any) => {
    await tx.putRow(row('rolled-back'))
    await tx.setState({ cursor: 'bad', maxSeen: at, watermark: null })
    await tx.addDeadLetter({ raw: null, reason: 'bad', at })
    throw new Error('fault')
  }), /fault/)
  assert.equal(await store.getRow(name, 'rolled-back'), undefined)
  assert.equal((await store.getState(name)).cursor, null)
  assert.equal((await store.listDeadLetters(name)).length, 0)
  await store.transaction(name, lease, async (tx: any) => {
    await tx.putRow(row("id'; DROP TABLE syncore_rows; --"))
    await tx.setState({ cursor: 'page-2', maxSeen: at, watermark: null })
  })
  assert.equal((await second.getState(name)).cursor, 'page-2')
  assert.ok(await second.getRow(name, "id'; DROP TABLE syncore_rows; --"))
  assert.equal(await second.getRow(name + '-isolated', "id'; DROP TABLE syncore_rows; --"), undefined)
  await assert.rejects(store.transaction(name + '-isolated', lease, async () => {}), /lease/)
  await pool.query("UPDATE syncore_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE sync_name=$1", [name])
  assert.equal(await second.renew(lease, 10000), null)
  const replacement = (await second.acquire(name, 10000))!
  assert.ok(replacement.epoch > lease.epoch)
  await assert.rejects(store.transaction(name, lease, async (tx: any) => tx.putRow(row('stale'))), /lease/)
  assert.equal(await store.release(lease), false)
  assert.ok(await second.renew(replacement, 10000))
  await second.release(replacement)

  // A transaction which outlives its lease must rollback even without a takeover.
  const short = (await store.acquire(name, 50))!
  await assert.rejects(store.transaction(name, short, async (tx: any) => {
    await tx.putRow(row('too-late'))
    await pool.query('SELECT pg_sleep(0.1)')
  }), /lease/)
  assert.equal(await store.getRow(name, 'too-late'), undefined)
})

test('Gate 2 restart resumes saved checkpoint; replay resolution is atomic', { skip: !url, timeout: 20000 }, async (t) => {
  const { postgresStore } = await import(adapterPath)
  let pool = new Pool({ connectionString: url })
  t.after(async () => pool.end())
  let store = postgresStore(pool)
  const name = randomUUID()
  const source = { async fetchPage({ cursor }: { cursor: string | null }) {
    if (cursor) throw new Error('source offline')
    return { records: [{ id: 'a', modifiedAt: at, data: { name: 'a' } }, null], nextCursor: 'page-2' }
  } }
  assert.equal((await runSync({ name, source, store })).status, 'stopped')
  await pool.end()
  pool = new Pool({ connectionString: url })
  store = postgresStore(pool)
  assert.equal((await store.getState(name)).cursor, 'page-2')
  assert.equal((await runSync({ name, store, source: { async fetchPage(args) {
    assert.equal(args.cursor, 'page-2')
    return { records: [{ id: 'b', modifiedAt: at, data: {} }], nextCursor: null }
  } } })).status, 'completed')
  const letter = (await store.listDeadLetters(name))[0]!
  assert.ok(letter.id)
  const lease = (await store.acquire(name, 10000))!
  await assert.rejects(store.transaction(name, lease, async (tx: any) => {
    await tx.putRow(row('replay'))
    await tx.resolveDeadLetter(letter.id)
    throw new Error('replay fault')
  }), /replay fault/)
  assert.equal(await store.getRow(name, 'replay'), undefined)
  assert.equal((await store.listDeadLetters(name)).length, 1)
  await store.release(lease)
  assert.deepEqual(await replayDeadLetters({ name, store, validate: () => ({ id: 'replay', modifiedAt: at, data: {} }) }), { replayed: 1, remaining: 0 })
  assert.ok(await store.getRow(name, 'replay'))
  assert.equal((await pool.query('SELECT resolved_at FROM syncore_dead_letters WHERE id=$1', [letter.id])).rows[0].resolved_at instanceof Date, true)
})

test('Gate 2: CI must provision PostgreSQL', { skip: !process.env.CI }, () => assert.ok(url))
