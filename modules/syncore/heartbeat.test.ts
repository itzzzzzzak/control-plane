import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { memoryStore, runSync } from './index.js'

test('heartbeat retains ownership during a fetch longer than TTL and cleans up', { timeout: 3000 }, async () => {
  const store = memoryStore()
  let renewals = 0
  const renew = store.renew.bind(store)
  store.renew = async (...args) => { renewals++; return renew(...args) }
  const result = await runSync({ name: 'slow', store, leaseTtlMs: 150,
    source: { async fetchPage() { await delay(500); return { records: [], nextCursor: null } } } })
  assert.equal(result.status, 'completed')
  assert.ok(renewals >= 2)
  const stopped = renewals
  await delay(170)
  assert.equal(renewals, stopped)
  assert.ok(await store.acquire('slow', 150))
})

test('failed heartbeat stops a hanging source and prevents any page commit', { timeout: 3000 }, async () => {
  const store = memoryStore()
  store.renew = async () => null
  const result = await runSync({ name: 'lost', store, leaseTtlMs: 60,
    source: { fetchPage: () => new Promise(() => {}) } })
  assert.equal(result.status, 'lease-lost')
  assert.equal(result.stats.pages, 0)
})
