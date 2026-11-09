import {
  LockTimeoutError,
  deadlineFor,
  getDefaultLockTimeout,
  waitUntil,
} from "./wait.ts";

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
 * without deadlocking. The owning thread's id and the re-entrancy depth live
 * in the shared buffer itself (cells 1 and 2), so re-entrancy is recognised
 * even when several `Mutex` instances (or several `SharedArrayBuffer` objects
 * received via `postMessage`) wrap the same memory in one thread. Buffers of
 * only 4 bytes (the pre-1.0.3 layout) still work, with re-entrancy tracked per
 * `Mutex` instance.
 *
 * Waiting is bounded: after `timeoutMs` (default {@link getDefaultLockTimeout})
 * `lock()` throws a {@link LockTimeoutError} naming the owner thread, so a
 * crashed lock holder cannot hang the other threads forever. The owner id is
 * also what `forceUnlock()` uses to recover a lock held by a dead thread.
 *
 * The same Mutex instance (backed by the same SharedArrayBuffer) must be
 * shared across all workers that access the protected data.
 */
/** Bytes needed for the full layout: state, owner id, depth. */
const FULL_BYTES = 12;

/** Random non-zero id identifying this thread as a lock owner. */
const THREAD_ID: number = (() => {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0]! & 0x7fffffff || 1;
})();

/** This thread's lock-owner id (what `Mutex.owner` reports while it holds one). */
export function getThreadId(): number {
  return THREAD_ID;
}

export interface MutexOptions {
  /** Lock-wait timeout in ms (`Infinity` = wait forever). */
  timeoutMs?: number;
  /**
   * Byte offset of this mutex inside `buffer` (multiple of 4). Lets many
   * mutexes live in one `SharedArrayBuffer` (see `SharedMemory` lock stripes).
   */
  byteOffset?: number;
}

export class Mutex {
  protected readonly cell: Int32Array;
  /** Whether the buffer has the owner/depth cells (>= 12 bytes). */
  protected readonly full: boolean;
  private readonly timeoutMs: number | undefined;

  constructor(buffer?: SharedArrayBuffer, options?: MutexOptions) {
    const sab = buffer ?? new SharedArrayBuffer(FULL_BYTES);
    const byteOffset = options?.byteOffset ?? 0;
    this.full = sab.byteLength - byteOffset >= FULL_BYTES;
    this.cell = new Int32Array(sab, byteOffset, this.full ? 3 : 1);
    this.timeoutMs = options?.timeoutMs;
  }

  /** The underlying SharedArrayBuffer, for sharing with other workers. */
  get buffer(): SharedArrayBuffer {
    return this.cell.buffer as SharedArrayBuffer;
  }

  /** Id of the thread currently holding the lock (0 = free / unknown). */
  get owner(): number {
    return this.full ? Atomics.load(this.cell, 1) : 0;
  }

  /** Whether the calling thread currently holds the lock. */
  get heldByCurrentThread(): boolean {
    return this.full
      ? Atomics.load(this.cell, 1) === THREAD_ID
      : (depths.get(this) ?? 0) > 0;
  }

  /** Acquire the mutex, blocking until it is available (or it times out). */
  lock(): void {
    // Fast path: uncontended acquire.
    if (Atomics.compareExchange(this.cell, 0, 0, 1) === 0) {
      this.markOwned();
      return;
    }
    // Re-entrant acquire by the owning thread. The owner id is cleared before
    // every release, so it equals ours only while we really hold the lock.
    if (this.heldByCurrentThread) {
      if (this.full) Atomics.add(this.cell, 2, 1);
      else depths.set(this, depths.get(this)! + 1);
      return;
    }
    this.lockSlow();
  }

  protected lockSlow(): void {
    const timeoutMs = this.timeoutMs ?? getDefaultLockTimeout();
    const deadline = deadlineFor(timeoutMs);
    while (true) {
      // Try to claim the lock: 0 (free) -> 1 (held, no waiters).
      if (Atomics.compareExchange(this.cell, 0, 0, 1) === 0) {
        this.markOwned();
        return;
      }
      // Lock is held elsewhere. Mark the cell as "has waiters" (1 -> 2), then
      // sleep. If the lock was released between our failed acquire and this
      // mark, the cell is 0 and `wait` returns immediately ("not-equal"), so
      // the loop retries instead of sleeping forever.
      Atomics.compareExchange(this.cell, 0, 1, 2);
      if (waitUntil(this.cell, 0, 2, deadline) === "timed-out") {
        throw new LockTimeoutError(
          "Mutex",
          timeoutMs,
          this.full ? `owner thread ${this.owner}` : undefined,
        );
      }
    }
  }

  protected markOwned(): void {
    if (this.full) {
      Atomics.store(this.cell, 2, 1);
      Atomics.store(this.cell, 1, THREAD_ID);
    } else {
      depths.set(this, 1);
    }
  }

  /** Release the mutex and wake any waiting workers. */
  unlock(): void {
    if (this.full) {
      if (Atomics.load(this.cell, 1) !== THREAD_ID) {
        throw new Error("Mutex: unlock() by a thread that does not hold it");
      }
      const depth = Atomics.load(this.cell, 2);
      if (depth > 1) {
        Atomics.store(this.cell, 2, depth - 1);
        return;
      }
      // Clear ownership *before* releasing so a stale owner id can never
      // make another thread look like the owner.
      Atomics.store(this.cell, 1, 0);
      Atomics.store(this.cell, 2, 0);
    } else {
      const depth = depths.get(this) ?? 0;
      if (depth > 1) {
        depths.set(this, depth - 1);
        return;
      }
      depths.delete(this);
    }
    // Release the lock. Only wake waiters if there were any (cell was 2);
    // in the uncontended case (cell was 1) we skip the expensive notify.
    if (Atomics.exchange(this.cell, 0, 0) === 2) {
      Atomics.notify(this.cell, 0, Infinity);
    }
  }

  /**
   * Forcibly release a lock held by `ownerId` (see {@link owner}), for
   * recovering from a crashed or terminated worker. Does nothing and returns
   * false unless that thread is still recorded as the owner. Only call this
   * once the owner is known to be dead: the data it was modifying may be
   * inconsistent.
   */
  forceUnlock(ownerId: number): boolean {
    if (!this.full || ownerId === 0) return false;
    if (Atomics.compareExchange(this.cell, 1, ownerId, 0) !== ownerId) {
      return false;
    }
    Atomics.store(this.cell, 2, 0);
    Atomics.store(this.cell, 0, 0);
    Atomics.notify(this.cell, 0, Infinity);
    return true;
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

/**
 * A `Mutex` whose re-entrancy depth is a plain field of this instance instead
 * of a cell in the shared buffer. It halves the atomic operations of an
 * uncontended lock/unlock pair (4 instead of 8), which matters on the write
 * hot path.
 *
 * Only valid where exactly one `StripeLock` instance per thread wraps a given
 * cell, so that the instance sees every acquisition made by its thread. That
 * holds for the per-key lock stripes of `SharedMemory` (one `SharedMemory` per
 * thread). The owner id is still published in the shared cell, so recovery of
 * a lock held by a dead thread (`forceUnlock`) works as before.
 */
export class StripeLock extends Mutex {
  private depth = 0;

  constructor(buffer: SharedArrayBuffer, options?: MutexOptions) {
    super(buffer, options);
    if (!this.full) throw new RangeError("StripeLock needs a 12-byte cell");
  }

  override get heldByCurrentThread(): boolean {
    return this.depth > 0;
  }

  override lock(): void {
    if (this.depth > 0) {
      this.depth++;
      return;
    }
    if (Atomics.compareExchange(this.cell, 0, 0, 1) === 0) {
      Atomics.store(this.cell, 1, THREAD_ID);
      this.depth = 1;
      return;
    }
    this.lockSlow();
  }

  protected override markOwned(): void {
    Atomics.store(this.cell, 1, THREAD_ID);
    this.depth = 1;
  }

  override unlock(): void {
    if (this.depth > 1) {
      this.depth--;
      return;
    }
    if (this.depth === 0) {
      throw new Error("Mutex: unlock() by a thread that does not hold it");
    }
    this.depth = 0;
    // Clear ownership before releasing so a stale owner id can never make
    // another thread look like the owner.
    Atomics.store(this.cell, 1, 0);
    if (Atomics.exchange(this.cell, 0, 0) === 2) {
      Atomics.notify(this.cell, 0, Infinity);
    }
  }
}

/** Re-entrancy depth for legacy 4-byte buffers, keyed by Mutex instance. */
const depths = new WeakMap<Mutex, number>();
