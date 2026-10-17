import { startHeartbeat, abortable } from "./heartbeat.js"
import { createHash } from "node:crypto"
import { LeaseLostError, SourceError, type SyncLease, type DeadLetter, type Source, type SourceRecord, type SyncStore, type SyncTx } from "./types.js"

export interface SyncStats {
  pages: number
  created: number
  updated: number
  unchanged: number
  deleted: number
  /** Duplicates and stale deliveries ignored. */
  skipped: number
  conflicts: number
  deadLettered: number
}

export interface SyncResult {
  status: "completed" | "stopped" | "busy" | "lease-lost"
  stats: SyncStats
  /** Why the run stopped. The checkpoint is intact: run again to resume. */
  error?: string
}

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  sleep: (ms: number) => Promise<void>
}

export interface RunOptions {
  name: string
  source: Source
  store: SyncStore
  /** Turn a raw record into a SourceRecord, or throw to dead-letter it. Default: the shape check below. */
  validate?: (raw: unknown) => SourceRecord
  retry?: Partial<RetryOptions>
  now?: () => Date
  leaseTtlMs?: number
}

const defaultRetry: RetryOptions = { maxAttempts: 4, baseDelayMs: 500, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

/** Stable JSON so the same data always hashes the same, whatever the key order. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)
export const hashData = (data: Record<string, unknown>) => createHash("sha256").update(canonical(data)).digest("hex")

export function validateRecord(raw: unknown): SourceRecord {
  if (raw === null || typeof raw !== "object") throw new Error("record is not an object")
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string" || r.id === "") throw new Error("record has no id")
  if (typeof r.modifiedAt !== "string" || Number.isNaN(Date.parse(r.modifiedAt))) throw new Error("record has no valid modifiedAt")
  if (r.deleted !== true && (r.data === null || typeof r.data !== "object" || Array.isArray(r.data))) throw new Error("record has no data object")
  return { id: r.id, modifiedAt: r.modifiedAt, data: (r.data ?? {}) as Record<string, unknown>, ...(r.deleted === true && { deleted: true }) }
}

const newer = (a: string, b: string | null) => b === null || Date.parse(a) > Date.parse(b)

/** Apply one validated record inside a transaction. Idempotent: applying it twice equals applying it once. */
async function applyRecord(tx: SyncTx, rec: SourceRecord, stats: SyncStats, at: string): Promise<void> {
  const row = await tx.getRow(rec.id)
  if (row && Date.parse(rec.modifiedAt) < Date.parse(row.sourceModifiedAt)) {
    stats.skipped++ // an older delivery than what we already have
    return
  }
  if (rec.deleted) {
    if (!row || row.deleted) {
      stats.skipped++
      return
    }
    await tx.putRow({ ...row, deleted: true, sourceModifiedAt: rec.modifiedAt })
    stats.deleted++
    return
  }
  const newHash = hashData(rec.data)
  if (!row) {
    await tx.putRow({ id: rec.id, data: rec.data, baseHash: newHash, sourceModifiedAt: rec.modifiedAt, deleted: false })
    stats.created++
    return
  }
  const locallyEdited = !row.deleted && hashData(row.data) !== row.baseHash
  if (locallyEdited && hashData(row.data) !== newHash) {
    // Both sides changed: the source wins, but what it overwrites is recorded first.
    await tx.addConflict({ recordId: rec.id, overwritten: row.data, applied: rec.data, resolution: "source-wins", at })
    stats.conflicts++
  } else if (!row.deleted && row.baseHash === newHash && !locallyEdited && row.sourceModifiedAt === rec.modifiedAt) {
    stats.skipped++ // the same delivery again
    return
  } else if (!row.deleted && row.baseHash === newHash && !locallyEdited) {
    await tx.putRow({ ...row, sourceModifiedAt: rec.modifiedAt })
    stats.unchanged++
    return
  }
  await tx.putRow({ id: rec.id, data: rec.data, baseHash: newHash, sourceModifiedAt: rec.modifiedAt, deleted: false })
  stats.updated++
}

/**
 * One sync run: full on the first run, incremental after. It never throws for an expected failure (the source
 * going down, a bad record): it returns `status: "stopped"` with the checkpoint intact so the next call resumes.
 */
export async function runSync(options: RunOptions): Promise<SyncResult> {
  const { name, source, store } = options
  const validate = options.validate ?? validateRecord
  const retry = { ...defaultRetry, ...options.retry }
  const now = options.now ?? (() => new Date())
  const stats: SyncStats = { pages: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, conflicts: 0, deadLettered: 0 }

  const ttl = options.leaseTtlMs ?? 30_000
  const lease = await store.acquire(name, ttl)
  if (!lease) return { status: "busy", stats }
  const heartbeat = startHeartbeat(store, lease, ttl)
  try {
  const state = await store.getState(name)
  const since = state.watermark
  let cursor = state.cursor
  let maxSeen = state.maxSeen

  for (;;) {
    heartbeat.signal.throwIfAborted()
    let page
    try {
      page = await abortable(fetchWithRetry(source, { cursor, since, signal: heartbeat.signal }, retry), heartbeat.signal)
    } catch (error) {
      if (heartbeat.signal.aborted) return { status: "lease-lost", stats }
      return { status: "stopped", stats, error: error instanceof Error ? error.message : "unknown error" }
    }

    const valid: SourceRecord[] = []
    const bad: DeadLetter[] = []
    for (const raw of page.records) {
      try {
        valid.push(validate(raw))
      } catch (error) {
        bad.push({ raw, reason: error instanceof Error ? error.message : "invalid record", at: now().toISOString() })
      }
    }
    for (const r of valid) if (newer(r.modifiedAt, maxSeen)) maxSeen = r.modifiedAt

    const pageStats: SyncStats = { ...stats, pages: 0 }
    try {
      await store.transaction(name, lease, async (tx) => {
        heartbeat.signal.throwIfAborted()
        for (const r of valid) await applyRecord(tx, r, pageStats, now().toISOString())
        for (const letter of bad) await tx.addDeadLetter(letter)
        const last = page.nextCursor === null
        // The checkpoint is saved in the same transaction as the records: both happen, or neither does.
        await tx.setState(last ? { cursor: null, maxSeen: null, watermark: maxSeen ?? since } : { cursor: page.nextCursor, maxSeen, watermark: since })
      })
    } catch (error) {
      if (error instanceof LeaseLostError) return { status: "lease-lost", stats }
      return { status: "stopped", stats, error: error instanceof Error ? error.message : "store error" }
    }
    Object.assign(stats, pageStats, { pages: stats.pages + 1, deadLettered: stats.deadLettered + bad.length })

    if (page.nextCursor === null) return { status: "completed", stats }
    cursor = page.nextCursor
  }
  } catch (error) {
    if (error instanceof LeaseLostError || heartbeat.signal.aborted) return { status: "lease-lost", stats }
    return { status: "stopped", stats, error: error instanceof Error ? error.message : "store error" }
  } finally { await heartbeat.stop(); await store.release(lease) }
}

async function fetchWithRetry(source: Source, args: { cursor: string | null; since: string | null; signal?: AbortSignal }, retry: RetryOptions) {
  for (let attempt = 1; ; attempt++) {
    try {
      args.signal?.throwIfAborted()
      return await source.fetchPage(args)
    } catch (error) {
      const retryable = error instanceof SourceError && error.retryable
      if (!retryable || attempt >= retry.maxAttempts) throw error
      await abortable(retry.sleep((error as SourceError).retryAfterMs ?? retry.baseDelayMs * 2 ** (attempt - 1)), args.signal)
    }
  }
}

/** Retry the dead letters (after a fix or a schema change). Those that now validate and apply are removed. */
export async function replayDeadLetters(options: Pick<RunOptions, "name" | "store" | "validate" | "now">): Promise<{ replayed: number; remaining: number }> {
  const { name, store } = options
  const validate = options.validate ?? validateRecord
  const now = options.now ?? (() => new Date())
  const lease = await store.acquire(name, 30_000)
  if (!lease) throw new Error("sync busy")
  try {
  const letters = await store.listDeadLetters(name)
  const fixed: string[] = []
  const stats: SyncStats = { pages: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, conflicts: 0, deadLettered: 0 }
  await store.transaction(name, lease, async (tx) => {
    for (const letter of letters) {
      let record: SourceRecord
      try { record = validate(letter.raw) } catch { continue }
      // Storage failures propagate: never swallow a failed write and resolve its letter.
      await applyRecord(tx, record, stats, now().toISOString())
      await tx.resolveDeadLetter(letter.id)
      fixed.push(letter.id)
    }
  })
  return { replayed: fixed.length, remaining: letters.length - fixed.length }
  } finally { await store.release(lease) }
}

