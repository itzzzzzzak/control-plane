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
  const slow = store.transaction("zoho", async (tx) => {
    tx.putRow(row("slow"))
    entered.resolve()
    await release.promise
  })
  await entered.promise
  // Current copy-on-write store commits this then the slow snapshot replaces it.
  await store.transaction("zoho", (tx) => tx.putRow(row("fast")))
  release.resolve()
  await slow
  assert.ok(await store.getRow("zoho", "slow"))
  assert.ok(await store.getRow("zoho", "fast"), "a committed transaction must not be erased")
})
