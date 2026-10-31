import { describe, expect, test } from "bun:test";
import {
  Shared,
  SharedMemory,
  getDefaultMemory,
  hasDefaultMemory,
  init,
  onMessage,
  setDefaultMemory,
  stopInit,
} from "../src/index.ts";

describe("Worker integration (M4)", () => {
  test("exportBuffers/fromBuffers round-trips all buffers", () => {
    const mem = new SharedMemory();
    const user = Shared(
      "m4-roundtrip",
      { name: "Alice", age: 30 },
      { memory: mem },
    );
    user.write({ name: "Bob", age: 31 });

    const buffers = mem.exportBuffers();
    const mem2 = SharedMemory.fromBuffers(buffers);
    const user2 = Shared<{ name: string; age: number }>(
      "m4-roundtrip",
      { name: "x", age: 0 },
      { memory: mem2 },
    );
    expect(user2.read()).toEqual({ name: "Bob", age: 31 });
  });

  test("a worker can call Shared() directly and share data with the main thread", async () => {
    const mem = new SharedMemory();
    // Make the singleton the memory we share with workers.
    setDefaultMemory(mem);
    const user = Shared(
      "m4-worker",
      { name: "Alice", age: 30 },
      { memory: mem },
    );

    // Main thread: answer buffer requests from new workers.
    await init();

    const workerCode = `
      import { Shared, init, onMessage } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      // Request the shared buffers from the main thread and wait for them.
      await init();
      // Register our own handler via onMessage(); messages are buffered until
      // the buffers have arrived.
      onMessage((e) => {
        if (e.data === "read") {
          // Just call Shared() — it uses the singleton initialized from the
          // buffers the main thread sent.
          const user = Shared("m4-worker", { name: "x" });
          self.postMessage(user.read());
        }
      });
    `;

    const worker = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(workerCode),
        import.meta.url,
      ),
      { type: "module" },
    );

    const read = await new Promise<{ name: string; age: number }>((resolve) => {
      worker.onmessage = (e) => {
        // Ignore the internal handshake request the worker sends to the main
        // thread; only resolve on a real reply.
        const data = e.data as
          { __sharedMemoryRequest?: boolean } | { name: string; age: number };
        if (!("__sharedMemoryRequest" in data)) {
          resolve(data as { name: string; age: number });
        }
      };
      worker.postMessage("read");
    });

    expect(read).toEqual({ name: "Alice", age: 30 });

    // A write from the main thread is visible to the worker.
    user.write({ name: "Bob", age: 31 });
    const read2 = await new Promise<{ name: string; age: number }>(
      (resolve) => {
        worker.onmessage = (e) => {
          const data = e.data as
            { __sharedMemoryRequest?: boolean } | { name: string; age: number };
          if (!("__sharedMemoryRequest" in data)) {
            resolve(data as { name: string; age: number });
          }
        };
        worker.postMessage("read");
      },
    );
    expect(read2).toEqual({ name: "Bob", age: 31 });

    worker.terminate();
    stopInit();
  });

  test("getDefaultMemory returns a singleton", () => {
    // Reset any singleton set by other tests.
    setDefaultMemory(new SharedMemory());
    const a = getDefaultMemory();
    const b = getDefaultMemory();
    expect(a).toBe(b);
    expect(hasDefaultMemory()).toBe(true);
  });
});
