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
    const sab =
      buffer ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.cell = new Int32Array(sab);
  }

  /** The underlying SharedArrayBuffer, for sharing with other workers. */
  get buffer(): SharedArrayBuffer {
    return this.cell.buffer as SharedArrayBuffer;
  }

  /**
   * Block the current thread until `notify()` is called.
   *
   * Returns "ok" when woken by a notification, "not-equal" if the value
   * changed before waiting, or "timed-out" if `timeoutMs` elapsed.
   */
  wait(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    return Atomics.wait(this.cell, 0, 0, timeoutMs);
  }

  /** Wake up to `count` workers blocked in `wait()`. */
  notify(count = 1): number {
    Atomics.store(this.cell, 0, 1);
    return Atomics.notify(this.cell, 0, count);
  }
}
