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
const workerScope = globalThis as unknown as {
  postMessage: (m: unknown) => void;
};

// Register a message handler. Messages are buffered until the buffers have
// arrived, then forwarded here in order.
onMessage(async (e) => {
  const msg = e.data as { type?: string; count?: number };
  if (msg.type === "increment") {
    const counter = Shared("counter", { value: 0 });
    const count = msg.count ?? 1;
    for (let i = 0; i < count; i++) {
      // Read the current value, then write the incremented value back.
      const current = counter.read();
      console.log(`Worker: read -> ${current.value}`);
      counter.write({ value: current.value + 1 });
      console.log(`Worker: write -> ${counter.read().value}`);

      // Report both the value after the write and after the read to the main
      // thread, then pause briefly so the example runs a little longer.
      workerScope.postMessage({ kind: "write", value: current.value + 1 });
      workerScope.postMessage({ kind: "read", value: counter.read().value });
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});
