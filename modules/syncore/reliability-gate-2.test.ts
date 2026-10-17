// Gate 2 RED integration contract. Enable with SYNCORE_TEST_DATABASE_URL pointing
// to a disposable PostgreSQL database. CI MUST enable this before merge.
// The module import is intentionally absent until the adapter is implemented.
import assert from "node:assert/strict"
import { test } from "node:test"

const url = process.env.SYNCORE_TEST_DATABASE_URL

test("Gate 2: durable adapter must exist and provide real PostgreSQL persistence", { skip: !url && "requires SYNCORE_TEST_DATABASE_URL" }, async () => {
  // A dynamically constructed import avoids compiling against a not-yet-created adapter.
  // Once implemented, replace this smoke test with full two-process transaction tests.
  const path = ["./", "postgres-store.js"].join("")
  const module = await import(path)
  assert.equal(typeof module.postgresStore, "function")
})

test("Gate 2: CI must provision PostgreSQL for durability verification", { skip: !process.env.CI }, () => {
  assert.ok(url, "CI must configure SYNCORE_TEST_DATABASE_URL and a PostgreSQL service")
})
