import assert from "node:assert/strict"
import { test } from "node:test"
import { memoryStore, replayDeadLetters, runSync, SourceError, validateRecord, type Page, type Source } from "./index.js"

const T = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString()
const rec = (i: number, over: Record<string, unknown> = {}) => ({ id: `r${i}`, modifiedAt: T(i), data: { name: `Customer ${i}`, phone: `A${i}` }, ...over })
const noSleep = { sleep: async () => {}, baseDelayMs: 1 }

/** A fake source over an array, paged by a cursor that is just the start index. Records fail on demand. */
function fakeSource(records: () => unknown[], pageSize = 100, hooks: { onCall?: (n: number, args: { cursor: string | null; since: string | null }) => void } = {}) {
  const calls: Array<{ cursor: string | null; since: string | null }> = []
  const source: Source = {
    async fetchPage(args) {
      calls.push(args)
      hooks.onCall?.(calls.length, args)
      const all = records().filter((r) => args.since === null || Date.parse((r as { modifiedAt: string }).modifiedAt) >= Date.parse(args.since))
      const start = args.cursor === null ? 0 : Number(args.cursor)
      const slice = all.slice(start, start + pageSize)
      const next = start + pageSize < all.length ? String(start + pageSize) : null
      return { records: slice, nextCursor: next } satisfies Page
    },
  }
  return { source, calls }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => rec(i + 1))

test("initial sync walks every page and sets the watermark when it completes", async () => {
  const store = memoryStore()
  const { source } = fakeSource(() => many(250))
  const result = await runSync({ name: "zoho", source, store })
  assert.equal(result.status, "completed")
  assert.equal(result.stats.created, 250)
  assert.equal(result.stats.pages, 3)
  const state = await store.getState("zoho")
  assert.deepEqual(state, { cursor: null, maxSeen: null, watermark: T(250) })
  assert.equal((await store.getRow("zoho", "r250"))?.data.phone, "A250")
})

test("a run that dies at page 3 resumes from its checkpoint: every record applied exactly once, never from zero", async () => {
  const store = memoryStore()
  let healthy = false
  const { source, calls } = fakeSource(() => many(250), 100, { onCall: (n) => { if (!healthy && n === 3) throw new Error("connection reset") } })
  const first = await runSync({ name: "zoho", source, store })
  assert.equal(first.status, "stopped")
  assert.match(first.error!, /connection reset/)
  assert.equal(first.stats.created, 200)
  assert.equal((await store.getState("zoho")).cursor, "200") // checkpoint after page 2

  healthy = true
  const second = await runSync({ name: "zoho", source, store })
  assert.equal(second.status, "completed")
  assert.equal(second.stats.created, 50) // only what was missing
  assert.equal(first.stats.created + second.stats.created, 250)
  assert.equal(calls.at(-1)!.cursor, "200") // resumed, not restarted
  assert.deepEqual((await store.getState("zoho")).watermark, T(250))
})

test("the store's transaction is all-or-nothing: a failure inside it keeps nothing", async () => {
  const store = memoryStore()
  const lease = (await store.acquire("zoho", 30000))!
  await assert.rejects(() =>
    store.transaction("zoho", lease, async (tx) => {
      await tx.putRow({ id: "x", data: {}, baseHash: "h", sourceModifiedAt: T(1), deleted: false })
      await tx.setState({ cursor: "100", maxSeen: T(1), watermark: null })
      throw new Error("crash mid-page")
    }),
  )
  assert.equal(await store.getRow("zoho", "x"), undefined)
  assert.equal((await store.getState("zoho")).cursor, null)
})

test("a duplicate or stale delivery changes nothing", async () => {
  const store = memoryStore()
  const first = [rec(1), rec(1)] // the same event delivered twice
  const result = await runSync({ name: "zoho", source: fakeSource(() => first).source, store })
  assert.equal(result.stats.created, 1)
  assert.equal(result.stats.skipped, 1)

  const stale = [rec(1, { modifiedAt: T(0), data: { name: "OLD", phone: "OLD" } })]
  const ignoresSince: Source = { fetchPage: async () => ({ records: stale, nextCursor: null }) } // a source that re-sends old events
  const again = await runSync({ name: "zoho", source: ignoresSince, store })
  assert.equal(again.stats.skipped, 1)
  assert.equal((await store.getRow("zoho", "r1"))?.data.phone, "A1")
})

test("both sides changed the same field: Zoho wins, and what it overwrote is recorded", async () => {
  const store = memoryStore()
  await runSync({ name: "zoho", source: fakeSource(() => [rec(1)]).source, store })
  store.localEdit("zoho", "r1", { name: "Customer 1", phone: "B" }) // the app edits the phone to B
  const update = [rec(1, { modifiedAt: T(500), data: { name: "Customer 1", phone: "A-new" } })] // Zoho changed it too
  const result = await runSync({ name: "zoho", source: fakeSource(() => update).source, store })
  assert.equal(result.stats.conflicts, 1)
  assert.equal((await store.getRow("zoho", "r1"))?.data.phone, "A-new") // Zoho wins
  const [conflict] = await store.listConflicts("zoho")
  assert.equal(conflict!.overwritten.phone, "B") // nothing lost silently
  assert.equal(conflict!.applied.phone, "A-new")
})

test("a local edit that Zoho never touched is not a conflict; an identical edit is not either", async () => {
  const store = memoryStore()
  await runSync({ name: "zoho", source: fakeSource(() => [rec(1)]).source, store })
  store.localEdit("zoho", "r1", { name: "Customer 1", phone: "A1" }) // same data as Zoho's new value below
  const update = [rec(1, { modifiedAt: T(500), data: { name: "Customer 1", phone: "A1" } })]
  const result = await runSync({ name: "zoho", source: fakeSource(() => update).source, store })
  assert.equal(result.stats.conflicts, 0)
})

test("a malformed record is dead-lettered with its reason; the rest of the page still syncs; replay fixes it", async () => {
  const store = memoryStore()
  const broken = { id: "bad", modifiedAt: "not a date", data: { name: "x" } }
  const records = [rec(1), broken, rec(2)]
  const result = await runSync({ name: "zoho", source: fakeSource(() => records).source, store })
  assert.equal(result.status, "completed")
  assert.equal(result.stats.created, 2)
  assert.equal(result.stats.deadLettered, 1)
  const letters = await store.listDeadLetters("zoho")
  assert.match(letters[0]!.reason, /modifiedAt/)

  // still broken: replay keeps it. After the fix (a lenient validator), replay applies it and clears the letter.
  assert.deepEqual(await replayDeadLetters({ name: "zoho", store }), { replayed: 0, remaining: 1 })
  const lenient = (raw: unknown) => validateRecord({ ...(raw as object), modifiedAt: T(9) })
  assert.deepEqual(await replayDeadLetters({ name: "zoho", store, validate: lenient }), { replayed: 1, remaining: 0 })
  assert.equal((await store.getRow("zoho", "bad"))?.data.name, "x")
})

test("a record deleted at the source becomes a tombstone; deleting an unknown record is ignored", async () => {
  const store = memoryStore()
  await runSync({ name: "zoho", source: fakeSource(() => [rec(1)]).source, store })
  const gone = [{ id: "r1", modifiedAt: T(600), deleted: true }, { id: "never-seen", modifiedAt: T(601), deleted: true }]
  const result = await runSync({ name: "zoho", source: fakeSource(() => gone).source, store })
  assert.equal(result.stats.deleted, 1)
  assert.equal(result.stats.skipped, 1)
  const row = await store.getRow("zoho", "r1")
  assert.equal(row?.deleted, true)
  assert.equal(row?.data.phone, "A1") // kept for audit
})

test("the second run is incremental: it asks only for changes since the watermark", async () => {
  const store = memoryStore()
  let data = many(5)
  const { source, calls } = fakeSource(() => data)
  await runSync({ name: "zoho", source, store })
  data = [...data.slice(0, 4), rec(5, { modifiedAt: T(900), data: { name: "Customer 5", phone: "A5-changed" } })]
  const result = await runSync({ name: "zoho", source, store })
  assert.equal(calls.at(-1)!.since, T(5))
  assert.equal(result.stats.updated, 1) // only the changed record came back (plus none unchanged)
  assert.equal((await store.getRow("zoho", "r5"))?.data.phone, "A5-changed")
})

test("rate limits are retried honoring retryAfter; when retries run out the run stops with its checkpoint intact", async () => {
  const store = memoryStore()
  let fails = 2
  const sleeps: number[] = []
  const flaky = fakeSource(() => many(3), 100, { onCall: () => { if (fails-- > 0) throw new SourceError("429", true, 2000) } })
  const ok = await runSync({ name: "zoho", source: flaky.source, store, retry: { sleep: async (ms) => void sleeps.push(ms) } })
  assert.equal(ok.status, "completed")
  assert.deepEqual(sleeps, [2000, 2000])

  const down = fakeSource(() => many(3), 100, { onCall: () => { throw new SourceError("503", true) } })
  const store2 = memoryStore()
  const stopped = await runSync({ name: "zoho", source: down.source, store: store2, retry: { maxAttempts: 3, ...noSleep } })
  assert.equal(stopped.status, "stopped")
  assert.equal(down.calls.length, 3)
  assert.deepEqual(await store2.getState("zoho"), { cursor: null, maxSeen: null, watermark: null })
})

test("a non-retryable source error stops immediately (no retries) and never throws out of runSync", async () => {
  const src = fakeSource(() => many(3), 100, { onCall: () => { throw new SourceError("401 unauthorized", false) } })
  const result = await runSync({ name: "zoho", source: src.source, store: memoryStore(), retry: noSleep })
  assert.equal(result.status, "stopped")
  assert.equal(src.calls.length, 1)
})

