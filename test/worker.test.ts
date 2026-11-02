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

  test("init() starts the refcount coordinator and shares the refcount buffer", async () => {
    // Reset the singleton so init() creates a fresh memory + coordinator.
    setDefaultMemory(new SharedMemory());
    expect(getDefaultMemory().refCountBuffer).toBeNull();

    await init();

    // The coordinator attaches the 5th refcount buffer to the memory so it is
    // exported to workers.
    expect(getDefaultMemory().refCountBuffer).not.toBeNull();

    // The exported buffers include the refcount buffer.
    const buffers = getDefaultMemory().exportBuffers();
    expect(buffers.refCount).not.toBeNull();

    stopInit();
  });

  test("a worker receives the refcount buffer and can report refcount events", async () => {
    setDefaultMemory(new SharedMemory());
    await init();

    const workerCode = `
      import { Shared, init, onMessage, getDefaultMemory } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      await init();
      onMessage((e) => {
        if (e.data === "check") {
          const mem = getDefaultMemory();
          self.postMessage({
            hasRefCount: mem.refCountBuffer !== null,
            // read() acquires a refcount event via the default tracker.
            value: Shared("m4-gc", { name: "x" }).read(),
          });
        }
      });
    `;

    const result = await new Promise<{
      hasRefCount: boolean;
      value: { name: string };
    }>((resolve) => {
      const worker = new Worker(
        new URL(
          "data:text/javascript," + encodeURIComponent(workerCode),
          import.meta.url,
        ),
        { type: "module" },
      );
      worker.onmessage = (e) => {
        const data = e.data as
          | { __sharedMemoryRequest?: boolean }
          | { hasRefCount: boolean; value: { name: string } };
        if (!("__sharedMemoryRequest" in data)) {
          resolve(data as { hasRefCount: boolean; value: { name: string } });
        }
      };
      worker.postMessage("check");
    });

    expect(result.hasRefCount).toBe(true);
    expect(result.value).toEqual({ name: "x" });

    stopInit();
  });

  test("a worker calling Shared() without init() throws instead of creating unshared buffers", async () => {
    const workerCode = `
      import { Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      try {
        // No await init() — must throw, not silently create unshared buffers.
        Shared("m4-no-init", { name: "x" });
        self.postMessage("no-error");
      } catch (e) {
        self.postMessage("error:" + (e as Error).message);
      }
    `;

    const result = await new Promise<string>((resolve) => {
      const worker = new Worker(
        new URL(
          "data:text/javascript," + encodeURIComponent(workerCode),
          import.meta.url,
        ),
        { type: "module" },
      );
      worker.onmessage = (e) => resolve(e.data as string);
    });

    expect(result).toContain("error:");
    expect(result).toContain("init()");
  });

  test("a worker can grow a pre-allocated chunk and the main thread sees it", async () => {
    // Use a tiny chunk size so a worker can exceed the initial capacity with a
    // modest amount of data. All chunks are pre-allocated at init and shared
    // with the worker; activation via SharedArrayBuffer.grow() is visible
    // across workers, so no broadcast is needed.
    setDefaultMemory(new SharedMemory({ chunkSize: 1024 }));
    await init();

    const workerCode = `
      import { Shared, init, onMessage, getDefaultMemory } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      await init();
      onMessage((e) => {
        if (e.data === "grow") {
          // Write a large array that exceeds the initial chunk capacity,
          // forcing the worker to activate additional pre-allocated chunks.
          const arr = Shared("m4-chunk-growth", [0]);
          const big = new Array(5000).fill(0).map((_, i) => i);
          arr.write(big);
          self.postMessage({
            capacity: getDefaultMemory().arrayTable.capacity,
            length: arr.read().length,
          });
        }
      });
    `;

    const result = await new Promise<{
      capacity: number;
      length: number;
    }>((resolve) => {
      const worker = new Worker(
        new URL(
          "data:text/javascript," + encodeURIComponent(workerCode),
          import.meta.url,
        ),
        { type: "module" },
      );
      worker.onmessage = (e) => {
        const data = e.data as
          | { __sharedMemoryRequest?: boolean }
          | { capacity: number; length: number };
        if (
          data !== null &&
          typeof data === "object" &&
          !("__sharedMemoryRequest" in data)
        ) {
          resolve(data as { capacity: number; length: number });
        }
      };
      worker.postMessage("grow");
    });

    // The worker grew the ArrayTable beyond the initial single chunk.
    expect(result.capacity).toBeGreaterThan(1024);
    expect(result.length).toBe(5000);

    // The main thread's ArrayTable has the same pre-allocated capacity.
    const mem = getDefaultMemory();
    expect(mem.arrayTable.capacity).toBe(result.capacity);

    // The data written by the worker is readable from the main thread.
    const arr = Shared("m4-chunk-growth", [0]);
    expect(arr.read().length).toBe(5000);

    stopInit();
  });
});
