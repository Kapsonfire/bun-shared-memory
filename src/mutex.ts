/**
 * A cross-worker, re-entrant mutex built on Atomics.
 *
 * Uses a single Int32 cell in a SharedArrayBuffer. The cell encodes the lock
 * state: 0 = free, 1 = held (no waiters), 2 = held (waiters present).
 *
 * `lock()` acquires the mutex with a compare-exchange spin, falling back to
 * `Atomics.wait` so the thread sleeps instead of busy-spinning while the lock
 * is held elsewhere. `unlock()` releases the cell and wakes waiting workers.
 *
 * The "2 = has waiters" encoding lets `unlock()` skip the (relatively
 * expensive) `Atomics.notify` entirely when no other worker is waiting — the
 * common uncontended case. When the cell was 2, all waiters are woken
 * (`notify(Infinity)`); those that lose the race re-mark the cell as 2 and
 * sleep again. The waiter re-checks the cell after marking it 2, so a release
 * that happens between the failed acquire and the `wait` is not lost (the
 * `wait` returns immediately with "not-equal" and the loop retries).
 *
 * The mutex is re-entrant: the same thread may acquire it multiple times
 * (e.g. a locked operation that internally calls another locked operation)
 * without deadlocking. Re-entrancy is tracked per-thread via a module-level
 * depth map, which is naturally per-thread because each worker has its own
 * module instance.
 *
 * The same Mutex instance (backed by the same SharedArrayBuffer) must be
 * shared across all workers that access the protected data.
 */
export class Mutex {
  private readonly cell: Int32Array;

  constructor(buffer?: SharedArrayBuffer) {
    const sab = buffer ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.cell = new Int32Array(sab);
  }

  /** The underlying SharedArrayBuffer, for sharing with other workers. */
  get buffer(): SharedArrayBuffer {
    return this.cell.buffer as SharedArrayBuffer;
  }

  /** Acquire the mutex, blocking until it is available. */
  lock(): void {
    const depth = depths.get(this) ?? 0;
    if (depth > 0) {
      // Already held by this thread; just bump the depth.
      depths.set(this, depth + 1);
      return;
    }
    while (true) {
      // Try to claim the lock: 0 (free) -> 1 (held, no waiters).
      if (Atomics.compareExchange(this.cell, 0, 0, 1) === 0) {
        depths.set(this, 1);
        return;
      }
      // Lock is held elsewhere. Mark the cell as "has waiters" (1 -> 2), then
      // sleep. If the lock was released between our failed acquire and this
      // mark, the cell is 0 and `wait` returns immediately ("not-equal"), so
      // the loop retries instead of sleeping forever.
      Atomics.compareExchange(this.cell, 0, 1, 2);
      Atomics.wait(this.cell, 0, 2);
    }
  }

  /** Release the mutex and wake any waiting workers. */
  unlock(): void {
    const depth = depths.get(this) ?? 0;
    if (depth <= 1) {
      depths.delete(this);
      // Release the lock. Only wake waiters if there were any (cell was 2);
      // in the uncontended case (cell was 1) we skip the expensive notify.
      const prev = Atomics.exchange(this.cell, 0, 0);
      if (prev === 2) {
        Atomics.notify(this.cell, 0, Infinity);
      }
    } else {
      depths.set(this, depth - 1);
    }
  }

  /** Run `fn` while holding the lock, releasing it afterwards. */
  withLock<T>(fn: () => T): T {
    this.lock();
    try {
      return fn();
    } finally {
      this.unlock();
    }
  }
}

/** Per-thread re-entrancy depth, keyed by Mutex instance. */
const depths = new WeakMap<Mutex, number>();
