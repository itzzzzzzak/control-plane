import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'
import { LeaseLostError, type Row, type SyncLease, type SyncStore, type SyncTx, type SyncState } from './types.js'

export interface PostgresStoreOptions {
  transactionTimeoutMs?: number
  maxPayloadBytes?: number
}

/** Migrations are explicit. Pools supplied by callers remain caller-owned. */
export function postgresStore(config: Pool | PoolConfig, options: PostgresStoreOptions = {}): SyncStore & { close(): Promise<void> } {
  const owned = !(config instanceof Pool)
  const pool = config instanceof Pool ? config : new Pool({
    ...config, max: config.max ?? 10, connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    statement_timeout: config.statement_timeout ?? 10000,
    idle_in_transaction_session_timeout: config.idle_in_transaction_session_timeout ?? 10000,
  })
  const timeout = options.transactionTimeoutMs ?? 10000
  const maxBytes = options.maxPayloadBytes ?? 1048576
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('invalid store limits')
  // Idle connection errors are handled by pg-pool by discarding that connection.
  // Checked-out connection failures are propagated below, never treated as success.
  const idleError = () => {}
  if (owned) pool.on('error', idleError)
  const json = (value: unknown): string => {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) throw new RangeError('payload is not JSON or exceeds store limit')
    return encoded
  }
  const ttlValid = (ttl: number) => { if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400000) throw new RangeError('invalid lease ttl') }
  const syncValid = (sync: string) => { if (!sync || Buffer.byteLength(sync) > 1024) throw new RangeError('invalid sync name') }

  // Bound even a caller-supplied pool's checkout; release a late checkout immediately.
  async function checkout(): Promise<PoolClient> {
    let expired = false
    let timer: ReturnType<typeof setTimeout>
    const connection = pool.connect().then(client => {
      if (expired) { client.release(); throw new Error('database checkout timed out') }
      return client
    })
    try {
      return await Promise.race([connection, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('database checkout timed out')) }, timeout)
      })])
    } finally { clearTimeout(timer!) }
  }
  const dbQuery = (client: PoolClient, text: string, values: unknown[] = []) => {
    // pg supports a per-query client-side read deadline in addition to DB timeouts.
    const query = { text, values, query_timeout: timeout }
    return client.query(query)
  }
  async function session<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await checkout()
    let failure: Error | undefined
    const onError = (error: Error) => { failure = error }
    client.on('error', onError)
    try {
      await dbQuery(client, 'BEGIN')
      await dbQuery(client, "SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$1,true), set_config('idle_in_transaction_session_timeout',$1,true)", [String(timeout)])
      const result = await fn(client)
      if (failure) throw failure
      await dbQuery(client, 'COMMIT')
      return result
    } catch (error) {
      failure = error instanceof Error ? error : new Error('database operation failed')
      try { await dbQuery(client, 'ROLLBACK') } catch (rollbackError) { failure = rollbackError as Error }
      if ((error as { code?: string }).code === '55000') throw new LeaseLostError()
      throw error
    } finally {
      client.removeListener('error', onError)
      client.release(failure)
    }
  }
  const readRow = async (client: PoolClient, sync: string, id: string): Promise<Row | undefined> => {
    const r = (await dbQuery(client, 'SELECT source_id AS id, data, base_hash AS "baseHash", source_modified_at AS "sourceModifiedAt", deleted FROM syncore_rows WHERE sync_name=$1 AND source_id=$2', [sync, id])).rows[0]
    return r as Row | undefined
  }
  const leaseParams = (lease: SyncLease) => [lease.sync, lease.token, lease.epoch.toString()]
  const toLease = (sync: string, r: QueryResultRow): SyncLease => ({ sync, token: r.token, epoch: BigInt(r.epoch), expiresAt: r.expires_at })
  return {
    async close() { if (owned) { await pool.end(); pool.removeListener('error', idleError) } },
    async acquire(sync, ttl) {
      syncValid(sync); ttlValid(ttl)
      return session(async client => {
        const r = (await dbQuery(client, 'SELECT * FROM syncore_claim_lease($1,$2)', [sync, ttl])).rows[0]
        return r ? toLease(sync, r) : null
      })
    },
    async renew(lease, ttl) {
      ttlValid(ttl)
      return session(async client => {
        const r = (await dbQuery(client, 'SELECT syncore_renew_lease($1,$2,$3,$4) AS expires_at', [...leaseParams(lease), ttl])).rows[0]!
        return r.expires_at ? { ...lease, expiresAt: r.expires_at } : null
      })
    },
    async release(lease) {
      return session(async client => Boolean((await dbQuery(client, 'SELECT syncore_release_lease($1,$2,$3) AS released', leaseParams(lease))).rows[0]!.released))
    },
    async getState(sync) {
      return session(async client => {
        const r = (await dbQuery(client, 'SELECT cursor,max_seen AS "maxSeen",watermark,run_since,query_since_set FROM syncore_state WHERE sync_name=$1', [sync])).rows[0]
        if (!r) return { cursor: null, maxSeen: null, watermark: null }
        return { cursor: r.cursor, maxSeen: r.maxSeen, watermark: r.watermark, ...(r.query_since_set ? { runSince: r.run_since } : {}) } as SyncState
      })
    },
    async transaction(sync, lease, fn) {
      if (lease.sync !== sync) throw new LeaseLostError()
      return session(async client => {
        const fence = () => dbQuery(client, 'SELECT syncore_assert_lease($1,$2,$3)', leaseParams(lease))
        await fence() // Holds the per-sync row lock until COMMIT/ROLLBACK.
        let active = true
        const query = async (sql: string, args: unknown[]) => {
          if (!active) throw new Error('transaction is closed')
          return dbQuery(client, sql, args)
        }
        const tx: SyncTx = {
          async getRow(id) { if (!active) throw new Error('transaction is closed'); return readRow(client, sync, id) },
          async putRow(row) {
            await query(`INSERT INTO syncore_rows(sync_name,source_id,data,base_hash,source_modified_at,deleted) VALUES($1,$2,$3,$4,$5,$6)
              ON CONFLICT(sync_name,source_id) DO UPDATE SET data=EXCLUDED.data,base_hash=EXCLUDED.base_hash,source_modified_at=EXCLUDED.source_modified_at,deleted=EXCLUDED.deleted`,
              [sync, row.id, json(row.data), row.baseHash, row.sourceModifiedAt, row.deleted])
          },
          async addConflict(c) {
            await query('INSERT INTO syncore_conflicts(id,sync_name,source_id,overwritten,applied,resolution,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [randomUUID(), sync, c.recordId, json(c.overwritten), json(c.applied), c.resolution, c.at])
          },
          async addDeadLetter(l) {
            await query('INSERT INTO syncore_dead_letters(id,sync_name,raw,reason,created_at) VALUES($1,$2,$3,$4,$5)', [randomUUID(), sync, json(l.raw), l.reason, l.at])
          },
          async resolveDeadLetter(id) {
            await query('UPDATE syncore_dead_letters SET resolved_at=clock_timestamp() WHERE sync_name=$1 AND id=$2 AND resolved_at IS NULL', [sync, id])
          },
          async setState(s) {
            await query(`INSERT INTO syncore_state(sync_name,cursor,max_seen,watermark,run_since,query_since_set) VALUES($1,$2,$3,$4,$5,$6)
              ON CONFLICT(sync_name) DO UPDATE SET cursor=EXCLUDED.cursor,max_seen=EXCLUDED.max_seen,watermark=EXCLUDED.watermark,run_since=EXCLUDED.run_since,query_since_set=EXCLUDED.query_since_set,updated_at=clock_timestamp()`, [sync, s.cursor, s.maxSeen, s.watermark, s.runSince ?? null, s.runSince !== undefined])
          },
        }
        try {
          let timer: ReturnType<typeof setTimeout> | undefined
          let result: Awaited<ReturnType<typeof fn>>
          try {
            result = await Promise.race([Promise.resolve().then(() => fn(tx)), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('transaction timed out')), timeout)
            })])
          } finally { clearTimeout(timer) }
          await fence() // DB clock at the commit decision; successors wait on this row lock.
          return result
        } finally { active = false }
      })
    },
    async getRow(sync, id) { return session(client => readRow(client, sync, id)) },
    async listConflicts(sync) {
      return session(async client => (await dbQuery(client, 'SELECT source_id AS "recordId",overwritten,applied,resolution,occurred_at AS at FROM syncore_conflicts WHERE sync_name=$1 ORDER BY occurred_at,id', [sync])).rows.map(r => ({ ...r, at: r.at.toISOString() })) as Awaited<ReturnType<SyncStore['listConflicts']>>)
    },
    async listDeadLetters(sync) {
      return session(async client => (await dbQuery(client, 'SELECT id,raw,reason,created_at AS at FROM syncore_dead_letters WHERE sync_name=$1 AND resolved_at IS NULL ORDER BY created_at,id', [sync])).rows.map(r => ({ ...r, at: r.at.toISOString() })) as Awaited<ReturnType<SyncStore['listDeadLetters']>>)
    },
  }
}
