import { SharedMemory, type SharedMemoryOptions } from "./memory.ts";
import {
  RefCountBuffer,
  RefCountCoordinator,
  RefCountTracker,
} from "./refcount.ts";

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

/** The module-level singleton SharedMemory, shared across all workers. */
let defaultMemory: SharedMemory | null = null;
/** Set while a worker is awaiting the buffers from the main thread. */
let waitingForInit = false;

/** Get the singleton SharedMemory, creating it on first use. */
export function getDefaultMemory(): SharedMemory {
  if (defaultMemory === null) {
    if (waitingForInit) {
      throw new Error(
        "Shared() called before the shared buffers arrived from the main thread. " +
          "Await init() before using Shared().",
      );
    }
    if (!Bun.isMainThread) {
      // A worker must call `await init()` to receive the shared buffers from
      // the main thread. Without it, creating a fresh memory here would
      // silently give the worker its own, unshared buffers — a hard-to-debug
      // bug where reads/writes don't propagate to the main thread.
      throw new Error(
        "Shared() called in a worker without init(). " +
          "Call `await init()` at the top of the worker to receive the shared " +
          "buffers from the main thread before using Shared().",
      );
    }
    // Standalone process (or main thread): create a fresh memory.
    defaultMemory = new SharedMemory();
  }
  return defaultMemory;
}

/** Set the singleton SharedMemory (e.g. from buffers received in a worker). */
export function setDefaultMemory(mem: SharedMemory): void {
  defaultMemory = mem;
}

/** Whether the singleton has been initialized yet. */
export function hasDefaultMemory(): boolean {
  return defaultMemory !== null;
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
  if (Bun.isMainThread) {
    if (!hasDefaultMemory()) {
      setDefaultMemory(new SharedMemory(options));
    }
    initMain();
    startCoordinator();
    return;
  }
  await initWorker();
}

/**
 * Stop the main-thread worker listener installed by `init()`. No-op in a
 * worker. Useful for tests and teardown.
 */
export function stopInit(): void {
  if (Bun.isMainThread) {
    stopMain();
    stopCoordinator();
  }
}

/** The main-thread RefCountCoordinator, started by `init()`. */
let coordinator: RefCountCoordinator | null = null;
/** Cleanup function returned by `coordinator.autoRegister()`. */
let unregisterWorkers: (() => void) | null = null;

/** The worker-side RefCountTracker, created from the shared refcount buffer. */
let workerTracker: RefCountTracker | null = null;

/** Get the worker's default RefCountTracker, or null if not available. */
export function getDefaultTracker(): RefCountTracker | null {
  return workerTracker;
}

/**
 * Start the reference-counting coordinator on the main thread.
 *
 * Creates a `RefCountCoordinator` over the default memory (attaching the 5th
 * refcount buffer so it is shared with workers) and starts automatic
 * maintenance: refcount events are drained and dead space is defragmented
 * when free space is low. Also auto-registers workers so their references are
 * released on close/crash.
 */
function startCoordinator(): void {
  if (coordinator !== null) return;
  const mem = getDefaultMemory();
  coordinator = new RefCountCoordinator(mem);
  unregisterWorkers = coordinator.autoRegister();
}

/** Stop the coordinator's maintenance timer and worker listener. */
function stopCoordinator(): void {
  if (coordinator !== null) {
    coordinator.stopAutoMaintenance();
    unregisterWorkers?.();
    unregisterWorkers = null;
    coordinator = null;
  }
}

/** The main-thread worker listener, so it can be removed by `stopInit()`. */
let mainListener:
  | ((worker: {
      postMessage: (msg: unknown) => void;
      addEventListener: (
        type: string,
        fn: (e: { data: unknown }) => void,
      ) => void;
    }) => void)
  | null = null;

/** Main thread: answer each worker's buffer request. */
function initMain(): void {
  const listener = (worker: {
    postMessage: (msg: unknown) => void;
    addEventListener: (
      type: string,
      fn: (e: { data: unknown }) => void,
    ) => void;
  }) => {
    worker.addEventListener("message", (e) => {
      const msg = e.data as { __sharedMemoryRequest?: boolean } | undefined;
      if (msg && msg.__sharedMemoryRequest) {
        const mem = getDefaultMemory();
        worker.postMessage({
          __sharedMemoryInit: true,
          buffers: mem.exportBuffers(),
        });
      }
    });
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
  scope.postMessage({ __sharedMemoryRequest: true });

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
      | undefined;
    if (msg && msg.__sharedMemoryInit && msg.buffers) {
      const mem = SharedMemory.fromBuffers(msg.buffers);
      setDefaultMemory(mem);
      // Create the worker-side refcount tracker from the shared refcount
      // buffer, so read() acquires references that the main thread's
      // coordinator can reclaim.
      if (msg.buffers.refCount) {
        const rcBuffer = new RefCountBuffer(msg.buffers.refCount);
        workerTracker = new RefCountTracker(
          rcBuffer,
          rcBuffer.allocateWorkerId(),
        );
      }
      pendingInitResolve?.();
      pendingInitResolve = null;
      // Forward any messages that arrived before the init reply.
      flush();
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
