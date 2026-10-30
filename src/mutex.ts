/**
 * A cross-worker, re-entrant mutex built on Atomics.
 *
 * Uses a single Int32 cell in a SharedArrayBuffer. `lock()` acquires the
 * mutex with a compare-exchange spin, falling back to `Atomics.wait` so the
 * thread sleeps instead of busy-spinning while the lock is held elsewhere.
 * `unlock()` releases the cell and wakes one waiting worker.
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
    const sab =
      buffer ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
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
      // Try to claim the lock: 0 (free) -> 1 (held).
      if (Atomics.compareExchange(this.cell, 0, 0, 1) === 0) {
        depths.set(this, 1);
        return;
      }
      // Lock is held elsewhere; sleep until notified.
      Atomics.wait(this.cell, 0, 1);
    }
  }

  /** Release the mutex and wake one waiting worker. */
  unlock(): void {
    const depth = depths.get(this) ?? 0;
    if (depth <= 1) {
      depths.delete(this);
      Atomics.store(this.cell, 0, 0);
      Atomics.notify(this.cell, 0, 1);
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
