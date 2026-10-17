import assert from "node:assert/strict"
import { test } from "node:test"
import { memoryStore, runSync, type Source } from "./index.js"

// RED baseline: these tests intentionally assert semantics the current prototype lacks.
// They must fail until per-sync ownership and serialized/fenced transactions are implemented.

const at = "2026-10-14T12:00:00.000Z"
const record = (id: string) => ({ id, modifiedAt: at, data: { name: id } })
const row = (id: string) => ({ id, data: { name: id }, baseHash: "test-hash", sourceModifiedAt: at, deleted: false })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test("RG1 RED: competing runners must not both fetch/process the same sync", async () => {
  const store = memoryStore()
  const entered = deferred()
  const release = deferred()
  let fetches = 0
  const source: Source = {
    async fetchPage() {
      fetches++
      entered.resolve()
      await release.promise
      return { records: [record("a")], nextCursor: null }
    },
  }

  const first = runSync({ name: "zoho", store, source })
  await entered.promise
  const second = runSync({ name: "zoho", store, source })
  // Ensure the second invocation has an opportunity to reach the source.
  await new Promise<void>((resolve) => setImmediate(resolve))
  release.resolve()
  const outcomes = await Promise.all([first, second])
  assert.equal(fetches, 1, "only the owner may fetch; contender should report busy")
  assert.equal(outcomes.filter((o) => o.status === "completed").length, 1)
})

test("RG1 RED: overlapping write transactions must not lose a committed row", async () => {
  const store = memoryStore()
  const entered = deferred()
  const release = deferred()
  const lease = (await store.acquire("zoho", 30000))!
  const slow = store.transaction("zoho", lease, async (tx) => {
    await tx.putRow(row("slow"))
    entered.resolve()
    await release.promise
  })
  await entered.promise
  // Current copy-on-write store commits this then the slow snapshot replaces it.
  const fast = store.transaction("zoho", lease, async (tx) => await tx.putRow(row("fast")))
  release.resolve()
  await Promise.all([slow, fast])
  assert.ok(await store.getRow("zoho", "slow"))
  assert.ok(await store.getRow("zoho", "fast"), "a committed transaction must not be erased")
})

// Deterministic fake clock: expired owners must not modify records after replacement.
test("RG1: expired lease is fenced even if old transaction resumes", async () => {
  let time = 1000
  const store = memoryStore(() => time)
  const old = (await store.acquire("zoho", 100))!
  const entered = deferred()
  const resume = deferred()
  const oldTx = store.transaction("zoho", old, async (tx) => {
    await tx.putRow(row("stale"))
    entered.resolve()
    await resume.promise
  })
  await entered.promise
  time = 1200
  resume.resolve()
  await assert.rejects(oldTx, /lease/)
  const replacement = (await store.acquire("zoho", 100))!
  assert.ok(replacement.epoch > old.epoch)
  assert.equal(await store.release(old), false)
  await store.transaction("zoho", replacement, async (tx) => await tx.putRow(row("fresh")))
  assert.equal(await store.getRow("zoho", "stale"), undefined)
  assert.ok(await store.getRow("zoho", "fresh"))
})

test("RG1: distinct sync names can run and commit independently", async () => {
  const store = memoryStore()
  const a = (await store.acquire("a", 30000))!
  const b = (await store.acquire("b", 30000))!
  const entered = deferred()
  const resume = deferred()
  const slow = store.transaction("a", a, async (tx) => {
    await tx.putRow(row("a"))
    entered.resolve()
    await resume.promise
  })
  await entered.promise
  await store.transaction("b", b, async (tx) => await tx.putRow(row("b")))
  assert.ok(await store.getRow("b", "b"))
  resume.resolve()
  await slow
})

