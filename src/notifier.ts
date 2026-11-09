import { deadlineFor, waitUntil } from "./wait.ts";

/**
 * A cross-worker notification primitive built on Atomics.
 *
 * Wraps `Atomics.wait` / `Atomics.notify` over a single Int32 cell so workers
 * can signal each other. A worker calls `wait()` to block until another
 * worker calls `notify()`.
 *
 * The same Notifier instance (backed by the same SharedArrayBuffer) must be
 * shared across all workers that need to communicate.
 */
export class Notifier {
  private readonly cell: Int32Array;

  constructor(buffer?: SharedArrayBuffer) {
    const sab = buffer ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.cell = new Int32Array(sab);
  }

  /** The underlying SharedArrayBuffer, for sharing with other workers. */
  get buffer(): SharedArrayBuffer {
    return this.cell.buffer as SharedArrayBuffer;
  }

  /**
   * Block the current thread until `notify()` is called.
   *
   * Returns "ok" when woken by a notification (or when a notification was
   * already pending), "timed-out" if `timeoutMs` elapsed.
   */
  wait(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    // Snapshot the current value, then block until it changes. Because each
    // notify() advances a monotonic counter, a later wait() observes a fresh
    // pulse and blocks again instead of returning immediately — making the
    // notifier reusable (not single-shot).
    const snapshot = Atomics.load(this.cell, 0);
    const result = waitUntil(
      this.cell,
      0,
      snapshot,
      deadlineFor(timeoutMs ?? Infinity),
    );
    if (result === "not-equal") {
      // The value changed between our snapshot and the wait, meaning a
      // notification already arrived — treat it as a successful wake.
      return "ok";
    }
    return result;
  }

  /**
   * Wake up to `count` workers blocked in `wait()`.
   *
   * Advances a monotonic counter so subsequent waits block on the new value
   * instead of being forever latched open by a one-time flag.
   */
  notify(count = 1): number {
    Atomics.add(this.cell, 0, 1);
    return Atomics.notify(this.cell, 0, count);
  }
}
