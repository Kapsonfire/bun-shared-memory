/**
 * Bounded, environment-aware waiting shared by all lock primitives.
 *
 * Two problems are solved here:
 *
 * 1. **Dead lock holders.** A worker that crashes (or is terminated) while
 *    holding a lock never releases it. Waiting without a timeout would hang
 *    every other thread forever, so all lock waits are bounded by a timeout
 *    and fail with a {@link LockTimeoutError} instead.
 * 2. **Browser main thread.** `Atomics.wait` throws on the browser main
 *    thread. There we fall back to a bounded busy-wait (which blocks the UI
 *    thread, exactly like `Atomics.wait` would elsewhere, but works).
 */

/** Default time a thread waits for a lock before giving up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

let defaultLockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;

/**
 * Set the per-thread default lock timeout in milliseconds (`Infinity` waits
 * forever, restoring the pre-1.0.3 behaviour). Applies to every lock primitive
 * that has no explicit timeout of its own. Each worker has its own module
 * instance, so call it in every thread that should use a non-default value.
 */
export function setDefaultLockTimeout(ms: number): void {
  if (!(ms > 0)) throw new RangeError("lock timeout must be > 0");
  defaultLockTimeoutMs = ms;
}

/** The current per-thread default lock timeout in milliseconds. */
export function getDefaultLockTimeout(): number {
  return defaultLockTimeoutMs;
}

/** Thrown when a lock could not be acquired within its timeout. */
export class LockTimeoutError extends Error {
  /** Which primitive timed out, e.g. `"Mutex"`. */
  readonly lock: string;
  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;
  constructor(lock: string, timeoutMs: number, detail?: string) {
    super(
      `${lock}: timed out after ${timeoutMs} ms waiting for the lock` +
        (detail ? ` (${detail})` : "") +
        ". A worker holding it may have crashed.",
    );
    this.name = "LockTimeoutError";
    this.lock = lock;
    this.timeoutMs = timeoutMs;
  }
}

declare const window: unknown;
declare const document: unknown;

/**
 * Whether the current thread may call `Atomics.wait`. False only on the
 * browser main thread (a `window` + `document` pair); Bun, Node.js and
 * workers may block.
 */
export const canBlock: boolean = !(
  typeof window !== "undefined" && typeof document !== "undefined"
);

/** Absolute deadline (ms, `performance.now()` clock) for a timeout. */
export function deadlineFor(timeoutMs: number): number {
  return timeoutMs === Infinity ? Infinity : performance.now() + timeoutMs;
}

/**
 * `Atomics.wait` bounded by an absolute `deadline`. Returns `"timed-out"` when
 * the deadline has passed. On the browser main thread it busy-waits instead.
 */
export function waitUntil(
  view: Int32Array,
  index: number,
  expected: number,
  deadline: number,
): "ok" | "not-equal" | "timed-out" {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return "timed-out";
  if (canBlock) return Atomics.wait(view, index, expected, remaining);
  while (Atomics.load(view, index) === expected) {
    if (performance.now() >= deadline) return "timed-out";
  }
  return "not-equal";
}
