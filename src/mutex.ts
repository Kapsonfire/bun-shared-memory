import {
  LockTimeoutError,
  deadlineFor,
  getDefaultLockTimeout,
  waitUntil,
} from "./wait.ts";

/**
 * A cross-worker, re-entrant mutex built on Atomics.
 *
 * Uses one Int32 state cell in a SharedArrayBuffer. The cell encodes both the
 * lock state and the owner: 0 = free, otherwise the owning thread's id, with
 * bit 31 set when at least one other thread is waiting for the lock. Keeping
 * the owner inside the state cell makes an uncontended acquire/release a
 * single `compareExchange` plus a single `exchange` — the hot path of every
 * write.
 *
 * `lock()` acquires the mutex with a compare-exchange. If the lock is held
 * elsewhere it first spins for a bounded number of loads (a critical section is
 * usually shorter than a sleep/wake round trip), then falls back to
 * `Atomics.wait` so the thread sleeps instead of busy-spinning for long.
 * `unlock()` releases the cell and wakes waiting workers.
 *
 * The waiter bit lets `unlock()` skip the (relatively expensive)
 * `Atomics.notify` entirely when no other worker is waiting — the common
 * uncontended case. When the bit was set, all waiters are woken
 * (`notify(Infinity)`); those that lose the race re-mark the cell and sleep
 * again. A release that lands between a waiter's failed compare-exchange and
 * its `Atomics.or` leaves the cell as a lone waiter bit, which the next loop
 * iteration claims with the second compare-exchange — so the release is never
 * lost and no waiter ever sleeps on a bit nobody can clear.
 *
 * The mutex is re-entrant: the same thread may acquire it multiple times
 * (e.g. a locked operation that internally calls another locked operation)
 * without deadlocking. The owner lives in the state cell itself; the
 * re-entrancy depth lives in the second cell of the buffer (when the buffer
 * is big enough), so re-entrancy is recognised even when several `Mutex`
 * instances (or several `SharedArrayBuffer` objects received via
 * `postMessage`) wrap the same memory in one thread. Buffers of only 4 bytes
 * (the pre-1.0.3 layout) still work, with re-entrancy tracked per `Mutex`
 * instance.
 *
 * Waiting is bounded: after `timeoutMs` (default {@link getDefaultLockTimeout})
 * `lock()` throws a {@link LockTimeoutError} naming the owner thread, so a
 * crashed lock holder cannot hang the other threads forever. The owner id is
 * also what `forceUnlock()` uses to recover a lock held by a dead thread.
 *
 * The same Mutex instance (backed by the same SharedArrayBuffer) must be
 * shared across all workers that access the protected data.
 */
/** Bytes needed for the full layout: the state cell plus a depth cell. */
const FULL_BYTES = 8;

/**
 * Bit 31 of the state cell: at least one thread is waiting for the lock.
 * Written as the *signed* int32 value (-2147483648, i.e. `0x80000000 | 0`),
 * matching what `Atomics` operations read back from an Int32Array.
 */
const WAITERS_BIT = -0x80000000;
/** Mask selecting the owner id in the state cell (0 = free). */
const OWNER_MASK = 0x7fffffff;
/**
 * Loads of the state cell a contended `lock()` makes, with a growing pause in
 * between, waiting for the owner to release before it marks the waiter bit and
 * sleeps (see `lockSlow`).
 */
const SPIN_ROUNDS = 64;
/**
 * Upper bound of the pause between two loads of a contended `lock()`, in
 * iterations of an empty loop. The pause doubles from 1 up to this; with
 * `SPIN_ROUNDS` a full spin phase lasts about 40 µs (macOS arm64).
 */
const SPIN_MAX_PAUSE = 4096;

/** Written by the spin pause (see `lockSlow`), only to keep it from being optimized away. */
let spinSink = 0;

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
  /** Whether the buffer has the state + depth cells (>= 8 bytes). */
  protected readonly full: boolean;
  private readonly timeoutMs: number | undefined;

  constructor(buffer?: SharedArrayBuffer, options?: MutexOptions) {
    const sab = buffer ?? new SharedArrayBuffer(FULL_BYTES);
    const byteOffset = options?.byteOffset ?? 0;
    this.full = sab.byteLength - byteOffset >= FULL_BYTES;
    this.cell = new Int32Array(sab, byteOffset, this.full ? 2 : 1);
    this.timeoutMs = options?.timeoutMs;
  }

  /** The underlying SharedArrayBuffer, for sharing with other workers. */
  get buffer(): SharedArrayBuffer {
    return this.cell.buffer as SharedArrayBuffer;
  }

  /** Id of the thread currently holding the lock (0 = free / unknown). */
  get owner(): number {
    return Atomics.load(this.cell, 0) & OWNER_MASK;
  }

  /** Whether the calling thread currently holds the lock. */
  get heldByCurrentThread(): boolean {
    return this.full
      ? (Atomics.load(this.cell, 0) & OWNER_MASK) === THREAD_ID
      : (depths.get(this) ?? 0) > 0;
  }

  /** Acquire the mutex, blocking until it is available (or it times out). */
  lock(): void {
    // Fast path: uncontended acquire. The owner id doubles as the "held"
    // state, so one compare-exchange is all it takes.
    if (Atomics.compareExchange(this.cell, 0, 0, THREAD_ID) === 0) {
      this.markOwned();
      return;
    }
    // Re-entrant acquire by the owning thread. The owner id is cleared before
    // every release, so it equals ours only while we really hold the lock.
    if (this.heldByCurrentThread) {
      if (this.full) Atomics.add(this.cell, 1, 1);
      else depths.set(this, depths.get(this)! + 1);
      return;
    }
    this.lockSlow();
  }

  protected lockSlow(): void {
    const timeoutMs = this.timeoutMs ?? getDefaultLockTimeout();
    const deadline = deadlineFor(timeoutMs);
    // Spin before sleeping, with a pause that doubles between two loads, for
    // up to about 40 µs. A sleeping waiter is expensive on both sides: the
    // sleep/wake round trip through the futex takes microseconds, and while
    // the waiter bit is set every `unlock()` of the owner pays for an
    // `Atomics.notify`. With one key written in a tight loop by several
    // workers, the owner takes the lock again and again; waiters that slept
    // after a short spin set the waiter bit almost every time, and the
    // notifies cut the throughput to a fraction (2 workers on one key: 14.7 M
    // writes/s with a 128-load spin, 47.5 M/s with this one). The growing
    // pause keeps the waiters off the cache line most of the time, so the
    // owner keeps it. Every contender spins, not only the first one.
    const cell = this.cell;
    let pause = 1;
    for (let spin = 0; spin < SPIN_ROUNDS; spin++) {
      if ((Atomics.load(cell, 0) & OWNER_MASK) === 0) break;
      // Waiting without touching the shared line. The loop writes a
      // module-level variable so the JIT cannot drop it as dead code.
      for (let i = 0; i < pause; i++) spinSink = (spinSink + i) & 0x7fffffff;
      if (pause < SPIN_MAX_PAUSE) pause <<= 1;
    }
    while (true) {
      // Try to claim the lock. The second compare-exchange also claims a cell
      // left as a lone waiter bit by a waiter whose release raced with the
      // marking (see the class comment).
      if (Atomics.compareExchange(this.cell, 0, 0, THREAD_ID) === 0) {
        this.markOwned();
        return;
      }
      if (
        Atomics.compareExchange(this.cell, 0, WAITERS_BIT, THREAD_ID) ===
        WAITERS_BIT
      ) {
        this.markOwned();
        return;
      }
      // Lock is held elsewhere. Mark the waiter bit, then sleep. `or` returns
      // the *old* value, so the cell now holds `old | WAITERS_BIT` — that is
      // what we wait on. A release stores 0, which differs from it, so a
      // release landing between the mark and the `wait` returns immediately
      // ("not-equal") and the loop retries instead of sleeping forever.
      const old = Atomics.or(this.cell, 0, WAITERS_BIT);
      if (old === 0) {
        // The owner released between the failed compare-exchange and the
        // marking: the cell is now a lone waiter bit, which the next
        // iteration's compare-exchange claims directly. Don't wait on it.
        continue;
      }
      if (
        waitUntil(this.cell, 0, old | WAITERS_BIT, deadline) === "timed-out"
      ) {
        throw new LockTimeoutError(
          "Mutex",
          timeoutMs,
          `owner thread ${old & OWNER_MASK}`,
        );
      }
    }
  }

  protected markOwned(): void {
    if (this.full) Atomics.store(this.cell, 1, 1);
    else depths.set(this, 1);
  }

  /** Release the mutex and wake any waiting workers. */
  unlock(): void {
    if (this.full) {
      const raw = Atomics.load(this.cell, 0);
      if ((raw & OWNER_MASK) !== THREAD_ID) {
        throw new Error("Mutex: unlock() by a thread that does not hold it");
      }
      const depth = Atomics.load(this.cell, 1);
      if (depth > 1) {
        Atomics.store(this.cell, 1, depth - 1);
        return;
      }
      // Release with one exchange: it clears the owner and returns the waiter
      // bit set while we held the lock. Only wake waiters if there were any;
      // in the uncontended case we skip the expensive notify.
      if (Atomics.exchange(this.cell, 0, 0) & WAITERS_BIT) {
        Atomics.notify(this.cell, 0, Infinity);
      }
    } else {
      const depth = depths.get(this) ?? 0;
      if (depth > 1) {
        depths.set(this, depth - 1);
        return;
      }
      depths.delete(this);
      if (Atomics.exchange(this.cell, 0, 0) & WAITERS_BIT) {
        Atomics.notify(this.cell, 0, Infinity);
      }
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
    if (ownerId === 0) return false;
    if ((Atomics.load(this.cell, 0) & OWNER_MASK) !== ownerId) {
      return false;
    }
    Atomics.store(this.cell, 0, 0);
    if (this.full) Atomics.store(this.cell, 1, 0);
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
 * of a cell in the shared buffer. An uncontended lock/unlock pair then costs
 * two atomic operations (one compare-exchange, one exchange), which matters on
 * the write hot path.
 *
 * Only valid where exactly one `StripeLock` instance per thread wraps a given
 * cell, so that the instance sees every acquisition made by its thread. That
 * holds for the per-key lock stripes of `SharedMemory` (one `SharedMemory` per
 * thread). The owner id is still published in the shared state cell, so
 * recovery of a lock held by a dead thread (`forceUnlock`) works as before.
 */
export class StripeLock extends Mutex {
  private depth = 0;

  constructor(buffer: SharedArrayBuffer, options?: MutexOptions) {
    super(buffer, options);
    if (!this.full) throw new RangeError("StripeLock needs an 8-byte cell");
  }

  override get heldByCurrentThread(): boolean {
    return this.depth > 0;
  }

  override lock(): void {
    if (this.depth > 0) {
      this.depth++;
      return;
    }
    // The thread id itself is the "held" state: one compare-exchange to own it.
    if (Atomics.compareExchange(this.cell, 0, 0, THREAD_ID) === 0) {
      this.depth = 1;
      return;
    }
    this.lockSlow();
  }

  protected override markOwned(): void {
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
    // One exchange clears ownership and returns the waiter bit accumulated
    // while the lock was held; only wake waiters if there were any.
    if (Atomics.exchange(this.cell, 0, 0) & WAITERS_BIT) {
      Atomics.notify(this.cell, 0, Infinity);
    }
  }
}

/** Re-entrancy depth for legacy 4-byte buffers, keyed by Mutex instance. */
const depths = new WeakMap<Mutex, number>();
