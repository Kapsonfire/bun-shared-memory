import { SharedMemory } from "./memory.ts";

/**
 * Worker integration (M4).
 *
 * Lets a worker simply call `Shared()` and share data with the main thread
 * without manually serializing buffers. The mechanism:
 *
 * - The main thread calls `shareWithWorkers()` once. It listens for new
 *   workers via Bun's `process.on("worker", ...)` and automatically sends the
 *   shared buffers to each one.
 * - Importing this module in a worker automatically installs a `message`
 *   wrapper that receives those buffers and initializes the module-level
 *   singleton `SharedMemory`. From then on, `Shared()` in that worker uses the
 *   same buffers as the main thread.
 *
 * To avoid a race where a worker calls `Shared()` before the init message
 * arrives, the wrapper **buffers** incoming messages until the init message
 * has been processed, then forwards them to the handler registered via
 * `onMessage()` in order. This lets the worker call `Shared()` freely once the
 * init message has been handled.
 *
 * The singleton is created lazily on first use, so a standalone process (no
 * workers) just works too.
 */

/** The module-level singleton SharedMemory, shared across all workers. */
let defaultMemory: SharedMemory | null = null;
/** Set by `installMessageWrapper()`: this code runs in a worker awaiting buffers. */
let waitingForInit = false;

/** Get the singleton SharedMemory, creating it on first use. */
export function getDefaultMemory(): SharedMemory {
  if (defaultMemory === null) {
    if (waitingForInit) {
      throw new Error(
        "Shared() called before the shared buffers arrived from the main thread. " +
          "Register your message handler via onMessage() and wait for the init " +
          "message before using Shared().",
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
 * Main thread: automatically share the singleton's buffers with every new
 * worker. Call once after creating the first SharedMemory. Returns a function
 * that stops sharing.
 */
export function shareWithWorkers(): () => void {
  const listener = (worker: { postMessage: (msg: unknown) => void }) => {
    const mem = getDefaultMemory();
    worker.postMessage({
      __sharedMemoryInit: true,
      buffers: mem.exportBuffers(),
    });
  };
  process.on("worker", listener);
  return () => {
    process.off("worker", listener);
  };
}

/**
 * Worker side: take over `self.onmessage` and initialize the singleton
 * SharedMemory from buffers sent by the main thread.
 *
 * Bun buffers incoming messages until a `message` listener is registered, so
 * installing the wrapper at module load guarantees the init message is
 * processed before any other message. Until the init message arrives, other
 * messages are buffered; once initialized, they are forwarded to the handler
 * registered via `onMessage()` in order.
 *
 * The worker's message handler must be registered via `onMessage()` (rather
 * than assigned to `self.onmessage` directly) so that this wrapper can buffer
 * messages until the shared buffers have arrived.
 */
function installMessageWrapper(): void {
  waitingForInit = true;
  let initialized = false;
  const pending: unknown[] = [];

  const scope = globalThis as unknown as {
    onmessage: ((e: { data: unknown }) => void) | null;
  };

  const wrapper = (e: { data: unknown }) => {
    const msg = e.data as
      | { __sharedMemoryInit?: boolean; buffers?: Parameters<typeof SharedMemory.fromBuffers>[0] }
      | undefined;
    if (msg && msg.__sharedMemoryInit && msg.buffers) {
      setDefaultMemory(SharedMemory.fromBuffers(msg.buffers));
      initialized = true;
      // Forward any messages that arrived before the init message.
      for (const data of pending) {
        messageHandler({ data });
      }
      pending.length = 0;
      return;
    }
    if (initialized) {
      messageHandler(e);
    } else {
      pending.push(e.data);
    }
  };

  scope.onmessage = wrapper;
}

/** The worker's real message handler, set via `onMessage()`. */
let messageHandler: (e: { data: unknown }) => void = () => {};

/**
 * Register the worker's message handler. Call this after importing the
 * library; messages are buffered until the shared buffers have arrived from
 * the main thread, then forwarded here in order.
 */
export function onMessage(handler: (e: { data: unknown }) => void): void {
  messageHandler = handler;
}

// Install the message wrapper at module load so the init message is processed
// before any other message (Bun buffers messages until a listener is set).
// Only do this in a worker — in the main thread there is no init message and
// the singleton is created lazily on first use.
if (!Bun.isMainThread) {
  installMessageWrapper();
}
