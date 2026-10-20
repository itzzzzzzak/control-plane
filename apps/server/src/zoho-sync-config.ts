export interface ZohoSyncConfig {
  databaseUrl: string
  token: string
  region: string
  module: string
  fields: string[]
  connectionId: string
  syncName: string
}

export function readZohoSyncConfig(env: NodeJS.ProcessEnv): ZohoSyncConfig {
  const databaseUrl = required(env, "DATABASE_URL")
  const token = required(env, "ZOHO_CRM_TOKEN")
  const region = env.ZOHO_CRM_REGION?.trim() || "com"
  const module = env.ZOHO_CRM_MODULE?.trim() || "Contacts"
  const fields = (env.ZOHO_CRM_FIELDS ?? "Last_Name,First_Name,Email,Phone")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
  const connectionId = env.ZOHO_CONNECTION_ID?.trim() || "local-account"
  const syncName = env.SYNCORE_SYNC_NAME?.trim() || `zoho:${connectionId}:${module}`
  return { databaseUrl, token, region, module, fields, connectionId, syncName }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required. Copy .env.example to .env and set it there.`)
  return value
}
