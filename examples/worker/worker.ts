/**
 * Worker integration example — worker thread.
 *
 * The worker calls `await init()` to receive the shared buffers from the main
 * thread, then uses `Shared()` to access the same value. Messages are handled
 * via `onMessage()` (buffered until the buffers arrive).
 */
import { Shared, init, onMessage } from "../../src/index.ts";

// Request the shared buffers from the main thread and wait for them.
await init();

// `self` is the worker global; cast to access postMessage (not in the main
// thread's type context).
const workerScope = globalThis as unknown as { postMessage: (m: unknown) => void };

// Register a message handler. Messages are buffered until the buffers have
// arrived, then forwarded here in order.
onMessage((e) => {
  if (e.data === "increment") {
    // Read the shared value, mutate it, and write it back.
    const counter = Shared("counter", { value: 0 });
    const current = counter.read();
    counter.write({ value: current.value + 1 });
    workerScope.postMessage(`incremented to ${counter.read().value}`);
  }
});
