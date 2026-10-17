import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { postgresStore } from './postgres-store.js'
import { once } from 'node:events'
import { runSync, replayDeadLetters, hashData } from './index.js'
const url = process.env.SYNCORE_TEST_DATABASE_URL
const at = '2026-10-17T00:00:00.000Z'
const row = (id: string) => ({ id, data: { name: id }, baseHash: hashData({ name: id }), sourceModifiedAt: at, deleted: false })

test('Gate 2 real PostgreSQL durability, fencing and rollback', { skip: !url, timeout: 20000 }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 })
  const other = new Pool({ connectionString: url, max: 4 })
  t.after(async () => { await pool.end(); await other.end() })
  const store = postgresStore(pool)
  const second = postgresStore(other)
  const name = randomUUID()
  const claims = await Promise.all([store.acquire(name, 10000), second.acquire(name, 10000)])
  assert.equal(claims.filter(Boolean).length, 1)
  const lease = claims.find(Boolean)!
  await assert.rejects(store.transaction(name, lease, async (tx) => {
    await tx.putRow(row('rolled-back'))
    await tx.setState({ cursor: 'bad', maxSeen: at, watermark: null })
    await tx.addDeadLetter({ raw: null, reason: 'bad', at })
    throw new Error('fault')
  }), /fault/)
  assert.equal(await store.getRow(name, 'rolled-back'), undefined)
  assert.equal((await store.getState(name)).cursor, null)
  assert.equal((await store.listDeadLetters(name)).length, 0)
  await store.transaction(name, lease, async (tx) => {
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
  await assert.rejects(store.transaction(name, lease, async (tx) => tx.putRow(row('stale'))), /lease/)
  assert.equal(await store.release(lease), false)
  assert.ok(await second.renew(replacement, 10000))
  await second.release(replacement)

  // A transaction which outlives its lease must rollback even without a takeover.
  const short = (await store.acquire(name, 50))!
  await assert.rejects(store.transaction(name, short, async (tx) => {
    await tx.putRow(row('too-late'))
    await pool.query('SELECT pg_sleep(0.1)')
  }), /lease/)
  assert.equal(await store.getRow(name, 'too-late'), undefined)
})

test('Gate 2 restart resumes saved checkpoint; replay resolution is atomic', { skip: !url, timeout: 20000 }, async (t) => {
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
  await assert.rejects(store.transaction(name, lease, async (tx) => {
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

async function worker(mode: string, name: string, t: import('node:test').TestContext) {
  const { fork } = await import('node:child_process')
  const child = fork(new URL('./postgres-worker.js', import.meta.url), [mode, name], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.on('data', data => { stderr += data })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const message = new Promise<any>((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`worker exited ${code}: ${stderr}`)))
  })
  const exited = once(child, 'exit')
  return { child, message, exited }
}

test('Gate 2 independent processes compete for one durable lease', { skip: !url, timeout: 15000 }, async t => {
  const name = randomUUID()
  const a = await worker('claim', name, t)
  const b = await worker('claim', name, t)
  const results = await Promise.all([a.message, b.message])
  assert.equal(results.filter(r => r.acquired).length, 1)
  await Promise.all([a.exited, b.exited])
})

test('Gate 2 SIGKILL rolls back a page; commit-response loss resumes durable checkpoint', { skip: !url, timeout: 20000 }, async t => {
  const pool = new Pool({ connectionString: url })
  t.after(async () => pool.end())
  const store = postgresStore(pool)
  for (const mode of ['crash', 'commit-response-lost']) {
    const name = randomUUID()
    const child = await worker(mode, name, t)
    await child.message
    child.child.kill('SIGKILL')
    await child.exited
    // Waiting for backend rollback/lock release is synchronized by this UPDATE.
    await pool.query("UPDATE syncore_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE sync_name=$1", [name])
    assert.equal(await store.getRow(name, 'uncommitted'), undefined)
    assert.equal((await store.listDeadLetters(name)).length, 0)
    const state = await store.getState(name)
    assert.equal(state.cursor, mode === 'crash' ? null : 'next')
    const result = await runSync({ name, store, source: { async fetchPage(args) {
      assert.equal(args.cursor, state.cursor)
      return { records: [{ id: 'committed', modifiedAt: at, data: {} }], nextCursor: null }
    } } })
    assert.equal(result.status, 'completed')
    assert.equal(result.stats.created, mode === 'crash' ? 1 : 0)
    assert.equal((await store.listConflicts(name)).length, 0)
  }
})

test('Gate 2 renewal waiting behind a page lock cannot revive an expired owner', { skip: !url, timeout: 10000 }, async t => {
  const pool = new Pool({ connectionString: url })
  const store = postgresStore(pool)
  const name = randomUUID()
  const lease = (await store.acquire(name, 500))!
  const holder = await pool.connect()
  const waiter = await pool.connect()
  t.after(async () => { await holder.query('ROLLBACK').catch(() => {}); holder.release(); waiter.release(); await pool.end() })
  await holder.query('BEGIN')
  await holder.query('SELECT * FROM syncore_leases WHERE sync_name=$1 FOR UPDATE', [name])
  const pid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const renewal = waiter.query('SELECT syncore_renew_lease($1,$2,$3,$4) AS expiry', [name, lease.token, lease.epoch.toString(), 10000])
  // Observe the waiter actually blocked on the held row before expiring it.
  let blocked = false
  for (let i = 0; i < 100; i++) {
    blocked = (await pool.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked
    if (blocked) break
    await pool.query('SELECT pg_sleep(0.01)')
  }
  assert.equal(blocked, true)
  await holder.query('SELECT pg_sleep(0.6)')
  await holder.query('COMMIT')
  assert.equal((await renewal).rows[0].expiry, null)
  assert.ok((await store.acquire(name, 10000))!.epoch > lease.epoch)
})

test('Gate 2 real heartbeat retains a slow fetch; distinct syncs and payload limits', { skip: !url, timeout: 10000 }, async t => {
  const pool = new Pool({ connectionString: url, max: 6 })
  t.after(async () => pool.end())
  const store = postgresStore(pool, { maxPayloadBytes: 100 })
  const name = randomUUID()
  assert.equal((await runSync({ name, store, leaseTtlMs: 600, source: { async fetchPage() {
    await pool.query('SELECT pg_sleep(1.4)')
    assert.equal(await store.acquire(name, 10000), null)
    return { records: [{ id: 'slow', modifiedAt: at, data: {} }], nextCursor: null }
  } } })).status, 'completed')
  const lease = (await store.acquire(name, 10000))!
  await assert.rejects(store.transaction(name, lease, tx => tx.putRow({ ...row('oversized'), data: { large: 'a'.repeat(101) } })), /payload/)
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const slow = store.transaction(name, lease, async tx => { await tx.putRow(row('first')); entered(); await wait })
  await ready
  const otherName = randomUUID()
  const otherLease = (await store.acquire(otherName, 10000))!
  try {
    await store.transaction(otherName, otherLease, tx => tx.putRow(row('independent')))
    assert.ok(await store.getRow(otherName, 'independent'))
  } finally { release() }
  await slow
  await store.release(lease)
  await store.release(otherLease)
})

test('Gate 2 backend termination rolls back and pool continues; checkout is bounded', { skip: !url, timeout: 10000 }, async t => {
  const applicationName = 'gate2-termination-' + randomUUID()
  const pool = new Pool({ connectionString: url, max: 2, application_name: applicationName })
  t.after(async () => pool.end())
  const store = postgresStore(pool)
  const name = randomUUID()
  const lease = (await store.acquire(name, 10000))!
  await assert.rejects(store.transaction(name, lease, async tx => {
    await tx.putRow(row('killed'))
    const active = (await pool.query("SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='idle in transaction' AND query LIKE 'INSERT INTO syncore_rows%' AND application_name=$1", [applicationName])).rows
    assert.equal(active.length, 1)
    await pool.query('SELECT pg_terminate_backend($1)', [active[0].pid])
  }))
  assert.equal(await store.getRow(name, 'killed'), undefined)
  await store.transaction(name, lease, tx => tx.putRow(row('recovered')))
  assert.ok(await store.getRow(name, 'recovered'))
  await store.release(lease)
  const occupied = new Pool({ connectionString: url, max: 1 })
  const connection = await occupied.connect()
  const limited = postgresStore(occupied, { transactionTimeoutMs: 50 })
  await assert.rejects(limited.getState(name), /checkout timed out/)
  connection.release()
  assert.equal((await limited.getState(name)).cursor, null)
  await occupied.end()
})

test('Gate 2 transaction deadline rejects hung callbacks and closes escaped handles', { skip: !url, timeout: 10000 }, async t => {
  const store = postgresStore({ connectionString: url }, { transactionTimeoutMs: 150 })
  t.after(() => store.close())
  const name = randomUUID()
  const lease = (await store.acquire(name, 10000))!
  let leaked!: import('./types.js').SyncTx
  await assert.rejects(store.transaction(name, lease, async tx => {
    leaked = tx
    await tx.putRow(row('deadline'))
    await new Promise(() => {})
  }), /timed out|timeout/)
  await assert.rejects(leaked.setState({ cursor: 'late', maxSeen: null, watermark: null }), /closed/)
  assert.equal(await store.getRow(name, 'deadline'), undefined)
  await store.release(lease)
})
