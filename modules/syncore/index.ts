// SyncCore: keeps two systems in step. This is the module's PUBLIC entry: other modules import only from here.
// Design: docs/modules/syncore.md.
export { hashData, replayDeadLetters, runSync, validateRecord } from "./engine.js"
export type { RetryOptions, RunOptions, SyncResult, SyncStats } from "./engine.js"
export { postgresStore } from "./postgres-store.js"
export type { PostgresStoreOptions } from "./postgres-store.js"
export { memoryStore } from "./memory-store.js"
export { AmbiguousRevisionError, LeaseLostError, SourceError } from "./types.js"
export type { SyncTx, StoredDeadLetter, SyncLease, Conflict, DeadLetter, Page, Row, Source, SourceRecord, SyncState, SyncStore } from "./types.js"

export const syncore = { name: "syncore", status: "engine with PostgreSQL persistence" } as const

