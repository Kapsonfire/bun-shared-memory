/**
 * Worker integration example — main thread.
 *
 * Run with: `bun run examples/worker/main.ts`
 *
 * The main thread creates a shared value, calls `init()` so it answers buffer
 * requests from new workers, then spawns a worker. The worker increments the
 * shared counter several times; after each write and each read it reports the
 * value back to the main thread, which prints it.
 */
import { Shared, init } from "../../src/index.ts";

// Create a shared value on the main thread.
const counter = Shared("counter", { value: 0 });

// Answer buffer requests from every new worker. Call this once, after the
// first SharedMemory exists (or it will be created from default options).
init();

// Spawn a worker. It calls `await init()` itself to receive the shared buffers.
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

// Ask the worker to increment the shared counter 5 times.
const TOTAL = 5;
worker.postMessage({ type: "increment", count: TOTAL });

let readsReceived = 0;
worker.onmessage = (e) => {
  // Ignore the worker's internal buffer-request handshake message.
  const data = e.data as
    { __sharedMemoryRequest?: boolean } | { kind: string; value: number };
  if (
    typeof data === "object" &&
    data !== null &&
    "__sharedMemoryRequest" in data
  ) {
    return;
  }
  const msg = data as { kind: string; value: number };
  console.log(`Main thread: worker ${msg.kind} -> value ${msg.value}`);
  console.log(`Main thread: counter.read() -> ${counter.read().value}`);

  // Once the worker has reported a read for every increment, we are done.
  if (msg.kind === "read" && ++readsReceived === TOTAL) {
    worker.terminate();
  }
};
