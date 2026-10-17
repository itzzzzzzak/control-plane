// Integration-test child process: no production entrypoint imports this module.
import { postgresStore } from './postgres-store.js'
import { hashData, runSync } from './engine.js'
const [mode, name] = process.argv.slice(2)
if (!name || !process.env.SYNCORE_TEST_DATABASE_URL || !process.send) throw new Error('test worker configuration missing')
const store = postgresStore({ connectionString: process.env.SYNCORE_TEST_DATABASE_URL })
const at = '2026-10-17T00:00:00.000Z'
if (mode === 'claim') {
  const lease = await store.acquire(name, 10000)
  process.send({ acquired: Boolean(lease), epoch: lease?.epoch.toString() })
  await store.close()
  process.disconnect()
} else if (mode === 'crash') {
  const lease = (await store.acquire(name, 10000))!
  await store.transaction(name, lease, async tx => {
    await tx.putRow({ id: 'uncommitted', data: {}, baseHash: hashData({}), sourceModifiedAt: at, deleted: false })
    await tx.setState({ cursor: 'lost-cursor', maxSeen: at, watermark: null })
    await tx.addDeadLetter({ raw: null, reason: 'uncommitted', at })
    process.send!({ ready: true })
    await new Promise(() => {}) // parent sends SIGKILL after observing writes
  })
} else if (mode === 'commit-response-lost') {
  const transaction = store.transaction.bind(store)
  store.transaction = async (...args) => {
    const result = await transaction(...args)
    process.send!({ committed: true })
    await new Promise(() => {}) // crash before runSync receives the commit outcome
    return result
  }
  await runSync({ name, store, source: { async fetchPage() {
    return { records: [{ id: 'committed', modifiedAt: at, data: {} }], nextCursor: 'next' }
  } } })
} else throw new Error('unknown worker mode')
