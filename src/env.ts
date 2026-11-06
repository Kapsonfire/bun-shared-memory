/**
 * Environment detection.
 *
 * The core of the library (`SharedArrayBuffer`/`Atomics`) runs identically in
 * Bun, Node.js and browsers (Web Workers). Only the worker handshake differs:
 * Bun exposes `Bun.isMainThread` and a `process.on("worker")` event, while
 * browsers have no equivalent and instead need an explicit per-worker
 * registration (`acceptWorker`).
 *
 * These helpers keep Bun-specific references behind feature detection so the
 * module evaluates safely in any environment (no `ReferenceError` in a browser
 * where `Bun`/`process`/`window` may be undefined).
 */

declare const Bun: { isMainThread?: boolean } | undefined;

/** Whether we are running in Bun. */
export const isBun: boolean =
  typeof Bun !== "undefined" && typeof Bun.isMainThread === "boolean";

/** Whether we are running in Node.js (a `process` with a version string). */
export const isNode: boolean =
  typeof process !== "undefined" &&
  typeof process.versions !== "undefined" &&
  typeof (process.versions as { node?: string }).node === "string";

/**
 * Whether the current context is a Web Worker (or similar worker global scope,
 * e.g. SharedWorker / ServiceWorker). Detected via the presence of the
 * `WorkerGlobalScope` global, which only exists inside a worker.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const WorkerGlobalScope: any;

export const isWorkerContext: boolean =
  typeof WorkerGlobalScope !== "undefined";

/**
 * Whether the current context is the main thread / main script.
 *
 * - In Bun, uses `Bun.isMainThread` directly.
 * - Otherwise we are on the main thread unless a worker global scope exists.
 */
export const isMainThread: boolean = isBun
  ? (Bun as { isMainThread: boolean }).isMainThread
  : !isWorkerContext;

/** Whether `process.on("worker", ...)` is available (Bun main thread only). */
export const supportsWorkerEvents: boolean = isBun && isMainThread;
