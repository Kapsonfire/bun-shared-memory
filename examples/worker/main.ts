/**
 * Worker integration example — main thread.
 *
 * Run with: `bun run examples/worker/main.ts`
 *
 * The main thread creates a shared value, calls `init()` so it answers buffer
 * requests from new workers, then spawns a worker. The worker reads and writes
 * the same shared value through the automatically-shared buffers.
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

// Ask the worker to increment the shared counter, then read it back.
worker.postMessage("increment");
worker.onmessage = (e) => {
  // Ignore the worker's internal buffer-request handshake message.
  const data = e.data as { __sharedMemoryRequest?: boolean } | string;
  if (
    typeof data === "object" &&
    data !== null &&
    "__sharedMemoryRequest" in data
  ) {
    return;
  }
  console.log("Main thread received:", data);
  console.log("Shared counter value:", counter.read());
  worker.terminate();
};
