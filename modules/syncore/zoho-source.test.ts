import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "connector-kit"
import zohoCrm from "connector-kit/zoho-crm"
import { SourceError, zohoSource, type ZohoExecutor } from "./index.js"

const T = (n: number) => new Date(Date.UTC(2026, 9, 20, 0, 0, n)).toISOString()

function fake(responses: unknown[]): ZohoExecutor & { calls: Array<{ action: string; input: Record<string, unknown> }> } {
  const calls: Array<{ action: string; input: Record<string, unknown> }> = []
  return {
    calls,
    async execute(action, input) {
      calls.push({ action, input })
      if (responses.length === 0) throw new Error("no fake response")
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
    },
  }
}

test("Zoho source uses COQL for a bounded initial page and adds required fields", async () => {
  const connection = fake([{ data: [{ id: "1", Modified_Time: T(1), Last_Name: "Lovelace" }], info: { more_records: false } }])
  const source = zohoSource({ connection, module: "Contacts", fields: ["Last_Name"], now: () => new Date(T(100)) })
  const page = await source.fetchPage({ cursor: null, since: null })
  assert.deepEqual(page.records, [{ id: "1", modifiedAt: T(1), data: { id: "1", Modified_Time: T(1), Last_Name: "Lovelace" } }])
  assert.ok(page.nextCursor?.startsWith("z1:"))
  assert.equal(page.watermark, T(100))
  assert.deepEqual(connection.calls, [
    { action: "coql.query", input: { query: `select id, Modified_Time, Last_Name from Contacts where Modified_Time <= '${T(100)}' order by Modified_Time asc limit 0, 2000` } },
  ])
})

test("Zoho source pages COQL and filters incremental reads at Zoho using the watermark", async () => {
  const connection = fake([
    { data: [{ id: "1", Modified_Time: T(5) }], info: { more_records: true } },
    { data: [{ id: "2", Modified_Time: T(6) }], info: { more_records: false } },
  ])
  const source = zohoSource({ connection, module: "Leads", fields: [], now: () => new Date(T(100)) })
  const first = await source.fetchPage({ cursor: null, since: T(4) })
  assert.ok(first.nextCursor?.startsWith("z1:"))
  await source.fetchPage({ cursor: first.nextCursor, since: T(4) })
  assert.equal(connection.calls[0]!.input.query, `select id, Modified_Time from Leads where Modified_Time <= '${T(100)}' and Modified_Time >= '${T(4)}' order by Modified_Time asc limit 0, 2000`)
  assert.equal(connection.calls[1]!.input.query, `select id, Modified_Time from Leads where Modified_Time <= '${T(100)}' and Modified_Time >= '${T(4)}' order by Modified_Time asc limit 2000, 2000`)
})

test("Zoho source walks deleted records after active records and emits recent tombstones", async () => {
  const providerCursor = "page:2/token"
  const connection = fake([
    { data: [], info: { more_records: false } },
    { items: [{ id: "old", deleted_time: T(1) }, { id: "new", deleted_time: T(9) }], nextCursor: providerCursor },
    { items: [], nextCursor: null },
  ])
  const source = zohoSource({ connection, module: "Contacts", fields: ["Email"], now: () => new Date(T(10)) })
  const active = await source.fetchPage({ cursor: null, since: T(5) })
  const first = await source.fetchPage({ cursor: active.nextCursor, since: T(5) })
  assert.deepEqual(first.records, [{ id: "new", modifiedAt: T(9), data: {}, deleted: true }])
  assert.ok(first.nextCursor?.startsWith("z1:"))
  const last = await source.fetchPage({ cursor: first.nextCursor, since: T(5) })
  assert.equal(last.nextCursor, null)
  assert.deepEqual(connection.calls[2]!.input, { module: "Contacts", type: "all", pageSize: 200, cursor: providerCursor })
})

test("Zoho source rejects configuration and forged cursors before calling ConnectorKit", async () => {
  const connection = fake([])
  assert.throws(() => zohoSource({ connection, module: "Contacts; delete", fields: [] }), /module/)
  assert.throws(() => zohoSource({ connection, module: "Contacts", fields: ["Email, Password"] }), /fields/)
  const source = zohoSource({ connection, module: "Contacts", fields: [] })
  await assert.rejects(() => source.fetchPage({ cursor: "https://evil.test", since: null }), (error: unknown) => error instanceof SourceError && !error.retryable)
  assert.equal(connection.calls.length, 0)
})

test("Zoho source refuses an active record beyond the frozen upper boundary", async () => {
  const connection = fake([{ data: [{ id: "future", Modified_Time: T(11) }], info: { more_records: false } }])
  const source = zohoSource({ connection, module: "Contacts", fields: [], now: () => new Date(T(10)) })
  await assert.rejects(
    () => source.fetchPage({ cursor: null, since: null }),
    (error: unknown) => error instanceof SourceError && /newer than/.test(error.message),
  )
})

test("Zoho source preserves ConnectorKit retryability and converts Retry-After seconds to milliseconds", async () => {
  const upstream = Object.assign(new Error("The provider rate limit was hit. Retry later."), { retryable: true, retryAfter: 7 })
  const source = zohoSource({ connection: fake([upstream]), module: "Contacts", fields: [] })
  await assert.rejects(
    () => source.fetchPage({ cursor: null, since: null }),
    (error: unknown) => error instanceof SourceError && error.retryable && error.retryAfterMs === 7000,
  )
})

test("Zoho source accepts a real ConnectorKit v0.7 Zoho connection", async () => {
  const calls: Array<{ url: URL; authorization: string | null }> = []
  const kit = createConnectorKit({
    retry: { maxRetries: 0 },
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), authorization: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ data: [{ id: "4150868000001", Modified_Time: T(1), Last_Name: "Lovelace" }], info: { more_records: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  const connection = kit.connect(zohoCrm, {
    connectionId: "account-1",
    variables: { region: "com" },
    credentials: { token: "test-access-token" },
  })
  const page = await zohoSource({ connection, module: "Contacts", fields: ["Last_Name"] }).fetchPage({ cursor: null, since: null })
  assert.equal((page.records[0] as { id: string }).id, "4150868000001")
  assert.equal(calls[0]!.url.href, "https://www.zohoapis.com/crm/v8/coql")
  assert.equal(calls[0]!.authorization, "Zoho-oauthtoken test-access-token")
})
