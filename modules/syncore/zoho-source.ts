import { SourceError, type Page, type Source, type SourceRecord } from "./types.js"

const FIELD = /^\$?[A-Za-z][A-Za-z0-9_]{0,79}$/
const MODULE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/
const PAGE_SIZE = 2000

export interface ZohoExecutor {
  execute(action: string, input: Record<string, unknown>): Promise<unknown>
}

export interface ZohoSourceOptions {
  connection: ZohoExecutor
  /** Zoho module API name, for example Contacts or a custom module API name. */
  module: string
  /** Fields copied into each target row. `id` and `Modified_Time` are added automatically. */
  fields: string[]
  /** Injected for deterministic tests. Defaults to the current time. */
  now?: () => Date
}

type Position = { phase: "records"; offset: number; until: string } | { phase: "deletes"; cursor: string | null; until: string }

/**
 * Adapt one ConnectorKit Zoho CRM connection to SyncCore's paged Source contract.
 * Active records are read with COQL so incremental runs filter at Zoho, then the deleted-records
 * feed is walked so removals become auditable tombstones.
 */
export function zohoSource(options: ZohoSourceOptions): Source {
  const { connection, module } = options
  const now = options.now ?? (() => new Date())
  if (!MODULE.test(module)) throw new Error(`Invalid Zoho module API name: ${JSON.stringify(module)}`)
  const fields = [...new Set(["id", "Modified_Time", ...options.fields])]
  if (fields.length > 50 || fields.some((field) => !FIELD.test(field))) throw new Error("Zoho fields must be 1-50 valid API field names")

  return {
    async fetchPage({ cursor, since }) {
      const position = decodeCursor(cursor, now)
      try {
        if (position.phase === "records") return await fetchRecords(connection, module, fields, position.offset, position.until, since)
        return await fetchDeletes(connection, module, position.cursor, position.until, since)
      } catch (error) {
        if (error instanceof SourceError) throw error
        throw connectorError(error)
      }
    },
  }
}

async function fetchRecords(connection: ZohoExecutor, module: string, fields: string[], offset: number, until: string, since: string | null): Promise<Page> {
  const bounds = [`Modified_Time <= '${until}'`, ...(since === null ? [] : [`Modified_Time >= '${iso(since)}'`])]
  const condition = ` where ${bounds.join(" and ")}`
  const query = `select ${fields.join(", ")} from ${module}${condition} order by Modified_Time asc limit ${offset}, ${PAGE_SIZE}`
  const body = object(await connection.execute("coql.query", { query }), "COQL result")
  const records = array(body.data, "COQL data").map(activeRecord)
  if (records.some((record) => Date.parse(record.modifiedAt) > Date.parse(until))) {
    throw new SourceError("Zoho CRM returned a record newer than the requested sync window", false)
  }
  const info = body.info === undefined ? {} : object(body.info, "COQL info")
  const more = info.more_records === true
  return {
    records,
    nextCursor: encodeCursor(more ? { phase: "records", offset: offset + PAGE_SIZE, until } : { phase: "deletes", cursor: null, until }),
    watermark: until,
  }
}

async function fetchDeletes(connection: ZohoExecutor, module: string, cursor: string | null, until: string, since: string | null): Promise<Page> {
  const result = object(
    await connection.execute("records.deleted", { module, type: "all", pageSize: 200, ...(cursor !== null && { cursor }) }),
    "deleted-records result",
  )
  const lower = since === null ? null : Date.parse(iso(since))
  const upper = Date.parse(until)
  const records = array(result.items, "deleted-records items")
    .map(deletedRecord)
    .filter((record) => (lower === null || Date.parse(record.modifiedAt) >= lower) && Date.parse(record.modifiedAt) <= upper)
  const next = result.nextCursor
  if (next !== null && typeof next !== "string") throw new SourceError("Zoho CRM returned an invalid deletion cursor", false)
  return { records, nextCursor: typeof next === "string" ? encodeCursor({ phase: "deletes", cursor: next, until }) : null, watermark: until }
}

function activeRecord(raw: unknown): SourceRecord {
  const data = object(raw, "COQL record")
  if (typeof data.id !== "string" || data.id === "") throw new SourceError("Zoho CRM returned a record without an id", false)
  if (typeof data.Modified_Time !== "string" || Number.isNaN(Date.parse(data.Modified_Time))) {
    throw new SourceError(`Zoho CRM record ${data.id} has no valid Modified_Time`, false)
  }
  return { id: data.id, modifiedAt: data.Modified_Time, data }
}

function deletedRecord(raw: unknown): SourceRecord {
  const data = object(raw, "deleted record")
  if (typeof data.id !== "string" || data.id === "") throw new SourceError("Zoho CRM returned a deleted record without an id", false)
  if (typeof data.deleted_time !== "string" || Number.isNaN(Date.parse(data.deleted_time))) {
    throw new SourceError(`Zoho CRM deleted record ${data.id} has no valid deleted_time`, false)
  }
  return { id: data.id, modifiedAt: data.deleted_time, data: {}, deleted: true }
}

function encodeCursor(position: Position): string {
  return `z1:${Buffer.from(JSON.stringify(position)).toString("base64url")}`
}

function decodeCursor(cursor: string | null, now: () => Date): Position {
  if (cursor === null) return { phase: "records", offset: 0, until: now().toISOString() }
  if (!cursor.startsWith("z1:")) throw new SourceError("The Zoho sync cursor is invalid or belongs to another source", false)
  try {
    const value = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString()) as Record<string, unknown>
    const until = typeof value.until === "string" ? iso(value.until) : ""
    if (value.phase === "records" && Number.isSafeInteger(value.offset) && (value.offset as number) >= 0) {
      return { phase: "records", offset: value.offset as number, until }
    }
    if (value.phase === "deletes" && (value.cursor === null || typeof value.cursor === "string")) {
      return { phase: "deletes", cursor: value.cursor as string | null, until }
    }
  } catch {
    // One generic error below keeps cursor internals and parse details out of user-facing errors.
  }
  throw new SourceError("The Zoho sync cursor is invalid or belongs to another source", false)
}

function iso(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) throw new SourceError("The SyncCore watermark is not a valid timestamp", false)
  return new Date(time).toISOString()
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SourceError(`Zoho CRM returned an invalid ${label}`, false)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new SourceError(`Zoho CRM returned invalid ${label}`, false)
  return value
}

function connectorError(error: unknown): SourceError {
  if (error === null || typeof error !== "object") return new SourceError("Zoho CRM request failed", false)
  const value = error as { message?: unknown; retryable?: unknown; retryAfter?: unknown }
  const message = typeof value.message === "string" ? value.message : "Zoho CRM request failed"
  const retryAfterMs = typeof value.retryAfter === "number" && Number.isFinite(value.retryAfter) ? value.retryAfter * 1000 : undefined
  return new SourceError(message, value.retryable === true, retryAfterMs)
}
