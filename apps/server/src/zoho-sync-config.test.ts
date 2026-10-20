import assert from "node:assert/strict"
import { test } from "node:test"
import { readZohoSyncConfig } from "./zoho-sync-config.js"

test("Zoho sync config uses safe defaults and a checkpoint name scoped to account and module", () => {
  const config = readZohoSyncConfig({ DATABASE_URL: "postgres://db", ZOHO_CRM_TOKEN: "secret" })
  assert.deepEqual(config, {
    databaseUrl: "postgres://db",
    token: "secret",
    region: "com",
    module: "Contacts",
    fields: ["Last_Name", "First_Name", "Email", "Phone"],
    connectionId: "local-account",
    syncName: "zoho:local-account:Contacts",
  })
})

test("Zoho sync config trims fields and accepts explicit tenant isolation", () => {
  const config = readZohoSyncConfig({
    DATABASE_URL: " postgres://db ",
    ZOHO_CRM_TOKEN: " token ",
    ZOHO_CRM_REGION: "eu",
    ZOHO_CRM_MODULE: "Leads",
    ZOHO_CRM_FIELDS: "Last_Name, Email, ,Company",
    ZOHO_CONNECTION_ID: "tenant-7",
    SYNCORE_SYNC_NAME: "custom-sync",
  })
  assert.deepEqual(config.fields, ["Last_Name", "Email", "Company"])
  assert.equal(config.connectionId, "tenant-7")
  assert.equal(config.syncName, "custom-sync")
  assert.equal(config.token, "token")
})

test("Zoho sync config never accepts a missing database URL or token", () => {
  assert.throws(() => readZohoSyncConfig({ ZOHO_CRM_TOKEN: "token" }), /DATABASE_URL/)
  assert.throws(() => readZohoSyncConfig({ DATABASE_URL: "postgres://db" }), /ZOHO_CRM_TOKEN/)
})
