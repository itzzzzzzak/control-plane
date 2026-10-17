import { LeaseLostError, type SyncLease, type SyncStore } from './types.js'

/** Race a remote operation with lease loss; callers may also honor the passed signal. */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    // Always observe operation rejection, including after cancellation.
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort() }
  })
}

/** One renewal at a time. A failed renewal is terminal; no retry can revive ownership. */
export function startHeartbeat(store: SyncStore, lease: SyncLease, ttl: number) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: Promise<void> = Promise.resolve()
  let stopped = false
  const schedule = () => {
    timer = setTimeout(() => {
      active = (async () => {
        try {
          if (!await store.renew(lease, ttl)) throw new LeaseLostError()
          if (!stopped) schedule()
        } catch { controller.abort(new LeaseLostError()) }
      })()
    }, Math.max(1, Math.floor(ttl / 3)))
  }
  schedule()
  return {
    signal: controller.signal,
    async stop() { stopped = true; clearTimeout(timer); await active },
  }
}
