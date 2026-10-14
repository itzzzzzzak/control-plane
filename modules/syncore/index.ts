// SyncCore: keeps two systems in step. This is the module's PUBLIC entry: other modules import only from here.
// Design: docs/modules/syncore.md.
export { hashData, replayDeadLetters, runSync, validateRecord } from "./engine.js"
export type { RetryOptions, RunOptions, SyncResult, SyncStats } from "./engine.js"
export { memoryStore } from "./memory-store.js"
export { SourceError } from "./types.js"
export type { Conflict, DeadLetter, Page, Row, Source, SourceRecord, SyncState, SyncStore } from "./types.js"

export const syncore = { name: "syncore", status: "engine (in-memory store)" } as const
