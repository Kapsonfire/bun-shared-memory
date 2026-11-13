import { isBun, isMainThread } from "./env.ts";
import { SharedMemory, type SharedMemoryOptions } from "./memory.ts";
import { getThreadId } from "./mutex.ts";
import { MaintenanceCoordinator } from "./coordinator.ts";

/**
 * Worker integration (M4).
 *
 * Lets a worker simply call `Shared()` and share data with the main thread
 * without manually serializing buffers. The mechanism is a request/response
 * handshake:
 *
 * - The main thread calls `init()` once. It listens for new workers via Bun's
 *   `process.on("worker", ...)` and answers each worker's buffer request.
 * - A worker calls `await init()` at startup. It sends a request to the main
 *   thread, which replies with the shared buffers; the worker reconstructs the
 *   module-level singleton `SharedMemory` from them. From then on, `Shared()`
 *   in that worker uses the same buffers as the main thread.
 *
 * To avoid a race where a worker calls `Shared()` before the buffers arrive,
 * the worker's message wrapper **buffers** incoming messages until the
 * handshake completes, then forwards them to the handler registered via
 * `onMessage()` in order.
 *
 * The singleton is created lazily on first use, so a standalone process (no
 * workers) just works too.
 */

/** Set while a worker is awaiting the buffers from the main thread. */
let waitingForInit = false;

/** Get the singleton SharedMemory, creating it on first use. */
export function getDefaultMemory(): SharedMemory {
  const live = SharedMemory.current();
  if (live !== null) return live;
  if (waitingForInit) {
    throw new Error(
      "Shared() called before the shared buffers arrived from the main thread. " +
        "Await init() before using Shared().",
    );
  }
  if (!isMainThread) {
    // A worker must call `await init()` to receive the shared buffers from
    // the main thread. Without it, creating a fresh memory here would
    // silently give the worker its own, unshared buffers — a hard-to-debug
    // bug where reads/writes don't propagate to the main thread. (The
    // SharedMemory constructor enforces this too.)
    throw new Error(
      "Shared() called in a worker without init(). " +
        "Call `await init()` at the top of the worker to receive the shared " +
        "buffers from the main thread before using Shared().",
    );
  }
  // Standalone process (or main thread): create the one fresh memory.
  return new SharedMemory();
}

/**
 * Declare `mem` as the default memory. A thread has exactly one SharedMemory
 * (the one that was constructed last and not disposed), so this only verifies
 * that `mem` is that instance; it exists for API compatibility.
 */
export function setDefaultMemory(mem: SharedMemory): void {
  if (SharedMemory.current() !== mem) {
    throw new Error(
      "setDefaultMemory: only the thread's single live SharedMemory can be the default.",
    );
  }
}

/** Whether this thread already has its SharedMemory. */
export function hasDefaultMemory(): boolean {
  return SharedMemory.current() !== null;
}

/**
 * Initialize the shared-memory handshake.
 *
 * - **Main thread**: call once after creating the first SharedMemory. It
 *   listens for new workers and answers each worker's buffer request. If no
 *   SharedMemory exists yet, one is created from `options` (e.g. to set a
 *   total memory budget via `maxTotalBytes`).
 * - **Worker**: `await init()` at startup. It requests the shared buffers from
 *   the main thread and reconstructs the singleton `SharedMemory` from them.
 *
 * Returns a promise that resolves once the handshake is set up (immediately in
 * the main thread, after the buffers arrive in a worker).
 */
export async function init(options?: SharedMemoryOptions): Promise<void> {
  if (isMainThread) {
    // The memory is created here, on the main thread only. Its constructor
    // registers it as this thread's single instance; `setDefaultMemory`
    // confirms that (and keeps the freshly created instance in use).
    setDefaultMemory(SharedMemory.current() ?? new SharedMemory(options));
    if (isBun) {
      // In Bun, the main thread can auto-discover workers via
      // `process.on("worker", ...)`.
      initMain();
      startCoordinator();
    }
    // On the browser main thread there is no way to discover new workers
    // automatically. Instead, hand the buffers to each worker explicitly via
    // `acceptWorker(worker)` after creating it.
    return;
  }
  await initWorker();
}

/**
 * Stop the main-thread worker listener installed by `init()`. No-op in a
 * worker. Useful for tests and teardown.
 */
export function stopInit(): void {
  if (isMainThread && isBun) {
    stopMain();
    stopCoordinator();
  }
}

/** The main-thread MaintenanceCoordinator, started by `init()`. */
let coordinator: MaintenanceCoordinator | null = null;

/**
 * Start the maintenance coordinator on the main thread.
 *
 * Creates a `MaintenanceCoordinator` over the default memory: dead space is
 * defragmented when the tables fill up (new chunk lists are broadcast to the
 * workers), and the locks of a worker that closes are force-released.
 *
 * Workers are registered per-handshake in `initMain()` (Bun) and
 * `acceptWorker()` (browser).
 */
function startCoordinator(): void {
  if (coordinator !== null) return;
  const mem = getDefaultMemory();
  coordinator = new MaintenanceCoordinator(mem, {
    onDefragment: (buffers) => broadcastChunkUpdate(buffers),
  });
}

/** Stop the coordinator's maintenance timer. */
function stopCoordinator(): void {
  if (coordinator !== null) {
    coordinator.stopAutoMaintenance();
    coordinator = null;
  }
}

// ---------------------------------------------------------------------------
/** The main-thread worker listener, so it can be removed by `stopInit()`. */
let mainListener: ((worker: HandshakeWorker) => void) | null = null;

/** Live workers on the main thread, for broadcasting chunk updates. */
const liveWorkers = new Set<HandshakeWorker>();

/** A worker as far as the handshake needs it (Bun and Web Workers). */
type HandshakeWorker = {
  postMessage: (msg: unknown) => void;
  addEventListener?: (type: string, fn: (e: { data: unknown }) => void) => void;
  onmessage?: unknown;
};

/**
 * Workers whose shared-buffer request this thread answers, registered by
 * `init()` (Bun: `process.on("worker")`) or by `acceptWorker()`. A worker is
 * registered once, whichever comes first, so it never gets two replies.
 */
const registeredWorkers = new WeakSet<object>();

/**
 * Answer `worker`'s shared-buffer request (once per worker), track it for
 * chunk updates and register it with the coordinator, which releases the
 * locks of a worker that dies.
 */
function registerHandshake(worker: HandshakeWorker): void {
  if (registeredWorkers.has(worker)) return;
  registeredWorkers.add(worker);
  liveWorkers.add(worker);
  const workerId = coordinator?.registerWorker(worker);
  const listener = (e: { data: unknown }) => {
    const msg = e.data as
      { __sharedMemoryRequest?: boolean; threadId?: number } | undefined;
    if (
      msg !== null &&
      typeof msg === "object" &&
      "__sharedMemoryRequest" in msg
    ) {
      if (workerId !== undefined && msg.threadId !== undefined) {
        coordinator?.setWorkerThreadId(workerId, msg.threadId);
      }
      const mem = getDefaultMemory();
      worker.postMessage({
        __sharedMemoryInit: true,
        buffers: mem.exportBuffers(),
      });
    }
  };
  if (typeof worker.addEventListener === "function") {
    // A listener of its own: an `onmessage` handler the caller set keeps
    // receiving every message once (it is called by the worker itself).
    worker.addEventListener("message", listener);
  } else {
    // No listener API: wrap the `onmessage` handler that is already set.
    const prior = worker.onmessage;
    worker.onmessage = (e: { data: unknown }) => {
      listener(e);
      if (typeof prior === "function") prior.call(worker, e);
    };
  }
}

/** Main thread (Bun): answer the buffer request of every new worker. */
function initMain(): void {
  const listener = (worker: HandshakeWorker) => {
    registerHandshake(worker);
  };
  mainListener = listener;
  process.on("worker", listener);
}

/** Remove the main-thread worker listener. */
function stopMain(): void {
  if (mainListener) {
    process.off("worker", mainListener);
    mainListener = null;
  }
  liveWorkers.clear();
}

/**
 * Broadcast a chunk update (new chunk lists after a defragmentation pass) to
 * all live workers. Workers apply it via `applyChunkUpdate()`.
 */
function broadcastChunkUpdate(buffers: {
  indexTable: SharedArrayBuffer[];
  dataTable: SharedArrayBuffer[];
  stringTable: SharedArrayBuffer[];
  arrayTable: SharedArrayBuffer[];
}): void {
  for (const worker of liveWorkers) {
    worker.postMessage({ __chunkUpdate: true, buffers });
  }
}

/**
 * Register a worker on the main thread so its shared-buffer request is
 * answered. The worker calls `await init()` itself to request the buffers.
 *
 * Works in Bun and in the browser. In Bun, `init()` also registers every new
 * worker automatically (`process.on("worker", ...)`); a worker that is
 * already registered, by `init()` or an earlier call, is not registered
 * again, so it never gets two replies. In the browser there is no way to
 * discover new workers, so each one must be registered, by this function or
 * by `spawnWorker()`.
 *
 * A message handler already assigned to `worker.onmessage` keeps receiving
 * every message once. Returns the same worker for chaining.
 */
export function acceptWorker<T extends HandshakeWorker>(worker: T): T {
  // In a worker there is nothing to answer.
  if (!isMainThread) return worker;
  registerHandshake(worker);
  return worker;
}

/**
 * Cross-environment worker options.
 *
 * `type` is standard in the Web Worker API. The remaining options are
 * Bun-only extensions; they are typed here so that `spawnWorker` compiles for
 * both browsers and Bun, but are ignored (and harmless) in the browser.
 */
export interface SpawnWorkerOptions {
  type?: "module" | "classic";
  env?: Record<string, string | undefined>;
  reusePort?: boolean;
  smol?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Spawn a worker and wire it up for shared memory automatically.
 *
 * The worker must call `await init()` at startup to receive the shared
 * buffers. `spawnWorker()` is `new Worker(...)` followed by `acceptWorker()`,
 * which answers the worker's buffer request, in Bun and in the browser alike
 * (in Bun a worker that `init()` already registered is not registered twice).
 *
 * Requires cross-origin isolation (`COOP`/`COEP`) in the browser for
 * `SharedArrayBuffer` to be available.
 *
 * ```ts
 * // worker.ts (the spawned module):
 * await init();
 * Shared("counter", { value: 0 });
 *
 * // main.ts:
 * await init();
 * const worker = spawnWorker(new URL("./worker.ts", import.meta.url), {
 *   type: "module",
 * });
 * ```
 */
export function spawnWorker(
  url: string | URL,
  options?: SpawnWorkerOptions,
): Worker {
  // `Worker` only constructs in a worker-capable global scope; a bundler will
  // map it to the platform Worker constructor.
  const worker = new Worker(url, options as WorkerOptions);
  return acceptWorker(worker) as Worker;
}

/** Worker: request the buffers from the main thread and await the reply. */
async function initWorker(): Promise<void> {
  waitingForInit = true;
  installMessageWrapper();

  const reply = new Promise<void>((resolve) => {
    pendingInitResolve = resolve;
  });

  const scope = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
  };
  scope.postMessage({ __sharedMemoryRequest: true, threadId: getThreadId() });

  await reply;
  waitingForInit = false;
}

/** Resolver for the worker's pending init handshake. */
let pendingInitResolve: (() => void) | null = null;

/**
 * Worker side: take over `self.onmessage` and initialize the singleton
 * SharedMemory from buffers sent by the main thread.
 *
 * Bun buffers incoming messages until a `message` listener is registered, so
 * installing the wrapper at module load guarantees the init reply is processed
 * before any other message. Until the buffers arrive, other messages are
 * buffered; once initialized, they are forwarded to the handler registered via
 * `onMessage()` in order.
 *
 * The worker's message handler must be registered via `onMessage()` (rather
 * than assigned to `self.onmessage` directly) so that this wrapper can buffer
 * messages until the shared buffers have arrived.
 */
function installMessageWrapper(): void {
  const scope = globalThis as unknown as {
    onmessage: ((e: { data: unknown }) => void) | null;
  };

  const wrapper = (e: { data: unknown }) => {
    const msg = e.data as
      | {
          __sharedMemoryInit?: boolean;
          buffers?: Parameters<typeof SharedMemory.fromBuffers>[0];
        }
      | {
          __chunkUpdate?: boolean;
          buffers?: {
            indexTable: SharedArrayBuffer[];
            dataTable: SharedArrayBuffer[];
            stringTable: SharedArrayBuffer[];
            arrayTable: SharedArrayBuffer[];
          };
        }
      | undefined;
    if (
      msg !== null &&
      typeof msg === "object" &&
      "__sharedMemoryInit" in msg &&
      msg.buffers
    ) {
      const mem = SharedMemory.fromBuffers(msg.buffers);
      setDefaultMemory(mem);
      pendingInitResolve?.();
      pendingInitResolve = null;
      // Forward any messages that arrived before the init reply.
      flush();
      return;
    }
    if (
      msg !== null &&
      typeof msg === "object" &&
      "__chunkUpdate" in msg &&
      msg.buffers &&
      hasDefaultMemory()
    ) {
      // The main thread replaced inactive chunks after a defragmentation
      // pass; apply the new chunk lists so this worker sees the replacement.
      getDefaultMemory().applyChunkUpdate(msg.buffers);
      return;
    }
    if (hasDefaultMemory() && hasHandler) {
      messageHandler(e);
    } else {
      pending.push(e.data);
    }
  };

  scope.onmessage = wrapper;
}

/** Messages buffered until the buffers arrive and a handler is registered. */
const pending: unknown[] = [];
/** Whether a real handler has been registered via `onMessage()`. */
let hasHandler = false;

/** The worker's real message handler, set via `onMessage()`. */
let messageHandler: (e: { data: unknown }) => void = () => {};

/** Forward buffered messages once the buffers and a handler are ready. */
function flush(): void {
  if (!(hasDefaultMemory() && hasHandler)) return;
  for (const data of pending) {
    messageHandler({ data });
  }
  pending.length = 0;
}

/**
 * Register the worker's message handler. Call this after `await init()`;
 * messages are buffered until the shared buffers have arrived from the main
 * thread and a handler is registered, then forwarded here in order.
 */
export function onMessage(handler: (e: { data: unknown }) => void): void {
  messageHandler = handler;
  hasHandler = true;
  flush();
}
