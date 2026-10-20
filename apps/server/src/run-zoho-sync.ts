import { createConnectorKit } from "connector-kit"
import zohoCrm from "connector-kit/zoho-crm"
import { postgresStore, runSync, zohoSource } from "../../../modules/syncore/index.js"
import { readZohoSyncConfig } from "./zoho-sync-config.js"

async function main(): Promise<void> {
  const config = readZohoSyncConfig(process.env)
  const store = postgresStore({ connectionString: config.databaseUrl })
  try {
    // SyncCore owns job-level retries. ConnectorKit still normalizes provider failures, but does
    // not multiply retries underneath the sync engine.
    const kit = createConnectorKit({ retry: { maxRetries: 0 } })
    const connection = kit.connect(zohoCrm, {
      connectionId: config.connectionId,
      variables: { region: config.region },
      credentials: { token: config.token },
    })
    const source = zohoSource({ connection, module: config.module, fields: config.fields })
    const result = await runSync({ name: config.syncName, source, store })

    console.log(JSON.stringify({ sync: config.syncName, status: result.status, stats: result.stats, ...(result.error !== undefined && { error: result.error }) }, null, 2))
    if (result.status !== "completed") process.exitCode = 1
  } finally {
    await store.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Zoho sync failed")
  process.exitCode = 1
})
