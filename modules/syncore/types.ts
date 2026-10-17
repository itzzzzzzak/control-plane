/** A record as the source system describes it, once validated. */
export interface SourceRecord {
  id: string
  /** ISO 8601 timestamp of the last change at the source. */
  modifiedAt: string
  data: Record<string, unknown>
  /** True when the record was deleted at the source. */
  deleted?: boolean
}

export interface Page {
  /** Raw records: validated by the engine, so a malformed one cannot break the run. */
  records: unknown[]
  /** Opaque cursor for the next page; null on the last page. */
  nextCursor: string | null
}

export interface Source {
  /** `since` is the watermark of the last completed run (null on the first run): return only changes at or after it. */
  fetchPage(args: { cursor: string | null; since: string | null }): Promise<Page>
}

/** Thrown by a source. `retryable` errors are retried; others stop the run. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = "SourceError"
  }
}

/** A synced row in the target database. */
export interface Row {
  id: string
  data: Record<string, unknown>
  /** Hash of `data` as last synced. A different hash of the current `data` means someone edited the row locally. */
  baseHash: string
  sourceModifiedAt: string
  deleted: boolean
}

export interface SyncState {
  /** Where to continue inside an unfinished run; null when no run is in progress. */
  cursor: string | null
  /** Highest `modifiedAt` seen so far in the unfinished run. */
  maxSeen: string | null
  /** `modifiedAt` high-water mark of the last completed run. */
  watermark: string | null
}

export interface Conflict {
  recordId: string
  /** What the database held (and Zoho overwrote). */
  overwritten: Record<string, unknown>
  /** What the source said. */
  applied: Record<string, unknown>
  resolution: "source-wins"
  at: string
}

export interface DeadLetter {
  raw: unknown
  reason: string
  at: string
}

/** Everything the engine may do inside one page's transaction. */
export interface SyncTx {
  getRow(id: string): Row | undefined
  putRow(row: Row): void
  addConflict(conflict: Conflict): void
  addDeadLetter(letter: DeadLetter): void
  setState(state: SyncState): void
}

export interface SyncLease {
  sync: string
  token: string
  epoch: bigint
  expiresAt: Date
}

export class LeaseLostError extends Error {
  constructor() { super("sync lease expired or ownership was fenced"); this.name = "LeaseLostError" }
}

export interface SyncStore {
  acquire(sync: string, ttlMs: number): Promise<SyncLease | null>
  renew(lease: SyncLease, ttlMs: number): Promise<SyncLease | null>
  release(lease: SyncLease): Promise<boolean>
  getState(sync: string): Promise<SyncState>
  /** All-or-nothing: if `fn` throws, none of its writes are kept. */
  transaction<T>(sync: string, lease: SyncLease, fn: (tx: SyncTx) => T | Promise<T>): Promise<T>
  getRow(sync: string, id: string): Promise<Row | undefined>
  listConflicts(sync: string): Promise<Conflict[]>
  listDeadLetters(sync: string): Promise<DeadLetter[]>
  /** Remove the dead letters at these positions (used by replay). */
  removeDeadLetters(sync: string, lease: SyncLease, indexes: number[]): Promise<void>
}
