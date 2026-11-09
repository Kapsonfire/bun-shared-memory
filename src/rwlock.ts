import {
  LockTimeoutError,
  deadlineFor,
  getDefaultLockTimeout,
  waitUntil,
} from "./wait.ts";

/**
 * A cross-worker, re-entrant read/write lock built on Atomics.
 *
 * Shared-array-backed locks have a single mutually-exclusive mode (`Mutex`),
 * which serializes *all* writers — the price paid for correctness in v1 (see
 * CHANGELOG v1.0.1 / review P1.1). A read/write lock relaxes that: any number
 * of *readers* may hold the lock at once, while *writers* remain exclusive.
 *
 * The lock state lives in a single Int32 cell in a `SharedArrayBuffer` and
 * encodes its state in the low bits, leaving the high bits for a reader count:
 *
 * ```
 * bit 0 (0x00000001)  WRITER          a writer holds the lock exclusively
 * bit 1 (0x00000002)  WRITES_QUEUED   >=1 writer is waiting; new readers block
 * bit 2.. (0xFFFFFFFC) READER_COUNT   number of active readers (unit = 4)
 * ```
 *
 * - A reader acquires by atomically bumping `READER_COUNT` (so many readers
 *   can be active concurrently), but only while no writer holds the lock and
 *   no writer is queued (the `WRITES_QUEUED` bit prevents reader starvation).
 * - A writer acquires when the cell is entirely free (no readers, no writer),
 *   or at a hand-off when only `WRITES_QUEUED` is set (a queued writer clears
 *   it and takes the `WRITER` bit). While it waits it sets `WRITES_QUEUED` so
 *   new readers back off.
 * - Release wakes waiting parties only when a cell transition could unblock
 *   someone: after the last reader leaves, or after a writer releases and
 *   there were queued waiting parties.
 *
 * Re-entrancy is tracked per-thread (per module instance) via WeakMaps, as in
 * `Mutex`. The same thread may acquire for reading repeatedly, and a thread
 * that already holds a write lock may read (a downgrade/read-inside-write is
 * safe). A thread holding a read lock must NOT attempt a write lock upgrade:
 * that would deadlock against the other readers of the thread's own read hold,
 * so it is rejected with an error.
 */
export class RWLock {
  private readonly cell: Int32Array;

  private readonly timeoutMs: number | undefined;

  /**
   * @param options.timeoutMs Lock-wait timeout in ms (`Infinity` = forever);
   *   defaults to `getDefaultLockTimeout()`. On expiry the acquire throws a
   *   `LockTimeoutError` instead of hanging behind a crashed lock holder.
   */
  constructor(buffer?: SharedArrayBuffer, options?: { timeoutMs?: number }) {
    const sab = buffer ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.cell = new Int32Array(sab);
    this.timeoutMs = options?.timeoutMs;
  }

  private timedOut(): never {
    throw new LockTimeoutError(
      "RWLock",
      this.timeoutMs ?? getDefaultLockTimeout(),
    );
  }

  /** The underlying SharedArrayBuffer, for sharing with other workers. */
  get buffer(): SharedArrayBuffer {
    return this.cell.buffer as SharedArrayBuffer;
  }

  /** Acquire the lock for reading; any number of readers may hold it. */
  readLock(): void {
    // If this thread already holds the write lock, it has exclusive access:
    // reading is trivially safe, so treat the read as a no-op.
    if ((writeDepths.get(this) ?? 0) > 0) return;
    const rd = readDepths.get(this) ?? 0;
    if (rd > 0) {
      readDepths.set(this, rd + 1);
      return;
    }
    const deadline = deadlineFor(this.timeoutMs ?? getDefaultLockTimeout());
    while (true) {
      const v = Atomics.load(this.cell, 0);
      if ((v & WRITER) !== 0 || (v & WRITES_QUEUED) !== 0) {
        // A writer holds the lock or is waiting: block until it releases.
        if (waitUntil(this.cell, 0, v, deadline) === "timed-out") {
          this.timedOut();
        }
        continue;
      }
      // Free or only-readers: bump the reader count.
      if (Atomics.compareExchange(this.cell, 0, v, v + READER_UNIT) === v) {
        readDepths.set(this, 1);
        return;
      }
    }
  }

  /** Release the lock after a `readLock()`. */
  readUnlock(): void {
    // If this thread holds the write lock, the matching readLock() was a no-op,
    // so nothing to release here.
    if ((writeDepths.get(this) ?? 0) > 0) return;
    const rd = readDepths.get(this) ?? 0;
    if (rd > 1) {
      readDepths.set(this, rd - 1);
      return;
    }
    readDepths.delete(this);
    while (true) {
      const v = Atomics.load(this.cell, 0);
      const next = v - READER_UNIT;
      if (Atomics.compareExchange(this.cell, 0, v, next) !== v) continue;
      // Wake blocked writers/readers when no writer and no readers remain.
      if ((next & (WRITER | READER_MASK)) === 0) {
        Atomics.notify(this.cell, 0, Infinity);
      }
      return;
    }
  }

  /**
   * Acquire the lock for writing (exclusive). Throws if the current thread
   * already holds a read lock (a reader→writer upgrade would deadlock).
   */
  writeLock(): void {
    const wd = writeDepths.get(this) ?? 0;
    if (wd > 0) {
      writeDepths.set(this, wd + 1);
      return;
    }
    if ((readDepths.get(this) ?? 0) > 0) {
      throw new Error(
        "RWLock: cannot upgrade a read lock to a write lock from the same thread (deadlock risk)",
      );
    }
    const deadline = deadlineFor(this.timeoutMs ?? getDefaultLockTimeout());
    while (true) {
      const v = Atomics.load(this.cell, 0);
      if (v === 0) {
        // Completely free: acquire directly.
        if (Atomics.compareExchange(this.cell, 0, 0, WRITER) === 0) {
          writeDepths.set(this, 1);
          return;
        }
        continue;
      }
      if (v === WRITES_QUEUED) {
        // No writer holds and no readers are active, but another writer queued
        // (WRITES_QUEUED is set). This is the hand-off: we may acquire now by
        // clearing the queued bit and setting the WRITER bit.
        if (Atomics.compareExchange(this.cell, 0, v, WRITER) === v) {
          writeDepths.set(this, 1);
          return;
        }
        continue;
      }
      // A writer holds the lock and/or readers are active: mark that a writer
      // waits (so new readers back off) and sleep until something changes.
      const q = v | WRITES_QUEUED;
      if (q !== v) {
        Atomics.compareExchange(this.cell, 0, v, q);
      }
      if (waitUntil(this.cell, 0, q, deadline) === "timed-out") {
        this.clearQueuedIfAlone();
        this.timedOut();
      }
    }
  }

  /**
   * After a writer gives up waiting, drop the WRITES_QUEUED bit it set if no
   * writer holds the lock, so readers are not blocked by a phantom waiter. (If
   * another writer is genuinely queued it re-sets the bit on its next loop.)
   */
  private clearQueuedIfAlone(): void {
    while (true) {
      const v = Atomics.load(this.cell, 0);
      if ((v & WRITES_QUEUED) === 0) return;
      if (Atomics.compareExchange(this.cell, 0, v, v & ~WRITES_QUEUED) === v) {
        Atomics.notify(this.cell, 0, Infinity);
        return;
      }
    }
  }

  /** Release the lock after a `writeLock()`. */
  writeUnlock(): void {
    const wd = writeDepths.get(this) ?? 0;
    if (wd > 1) {
      writeDepths.set(this, wd - 1);
      return;
    }
    writeDepths.delete(this);
    while (true) {
      const v = Atomics.load(this.cell, 0);
      // A writer holds bit 0; leave the WRITES_QUEUED bit and reader count
      // intact (readers may already have started re-acquiring).
      const next = v & ~WRITER;
      if (Atomics.compareExchange(this.cell, 0, v, next) !== v) continue;
      // Wake everyone; readers can now acquire if no WQ bit blocks them.
      Atomics.notify(this.cell, 0, Infinity);
      return;
    }
  }

  /** Run `fn` while holding the read lock. */
  withReadLock<T>(fn: () => T): T {
    this.readLock();
    try {
      return fn();
    } finally {
      this.readUnlock();
    }
  }

  /** Run `fn` while holding the write lock. */
  withWriteLock<T>(fn: () => T): T {
    this.writeLock();
    try {
      return fn();
    } finally {
      this.writeUnlock();
    }
  }
}

// Bit layout (see class doc).
const WRITER = 0b01;
const WRITES_QUEUED = 0b10;
const READER_UNIT = 0b100; // reader count increments by 4 (bits 2+)
const READER_MASK = ~(WRITER | WRITES_QUEUED);

/** Per-thread read re-entrancy depth, keyed by RWLock instance. */
const readDepths = new WeakMap<RWLock, number>();
/** Per-thread write re-entrancy depth, keyed by RWLock instance. */
const writeDepths = new WeakMap<RWLock, number>();
