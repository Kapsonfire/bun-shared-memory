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
    // One SharedMemory per thread: release the first before reconstructing.
    mem.dispose();
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

  test("a worker receives the shared buffers and reads a value via init()", async () => {
    setDefaultMemory(new SharedMemory());
    await init();

    const workerCode = `
      import { Shared, init, onMessage } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      await init();
      onMessage((e) => {
        if (e.data === "check") {
          self.postMessage({ value: Shared("m4-gc", { name: "x" }).read() });
        }
      });
    `;

    const result = await new Promise<{ value: { name: string } }>((resolve) => {
      const worker = new Worker(
        new URL(
          "data:text/javascript," + encodeURIComponent(workerCode),
          import.meta.url,
        ),
        { type: "module" },
      );
      worker.onmessage = (e) => {
        const data = e.data as
          { __sharedMemoryRequest?: boolean } | { value: { name: string } };
        if (!("__sharedMemoryRequest" in data)) {
          resolve(data as { value: { name: string } });
        }
      };
      worker.postMessage("check");
    });

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

  test("a worker can read and mutate a nested array shared with the main thread", async () => {
    setDefaultMemory(new SharedMemory());
    await init();

    const grid = Shared<number[][]>(
      "m4-nested",
      [
        [1, 2],
        [3, 4],
      ],
      { memory: getDefaultMemory() },
    );

    const workerCode = `
      import { Shared, init, onMessage } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      await init();
      onMessage((e) => {
        if (e.data === "mutate") {
          const grid = Shared("m4-nested", [[0]]);
          // Read a nested element, then mutate a nested element in place.
          const before = grid[0][1];
          grid[1][0] = 99;
          grid[0].push(5);
          self.postMessage({ before, after: grid.read() });
        }
      });
    `;

    const result = await new Promise<{ before: number; after: number[][] }>(
      (resolve) => {
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
            | { before: number; after: number[][] };
          if (data !== null && typeof data === "object" && "after" in data) {
            resolve(data as { before: number; after: number[][] });
          }
        };
        worker.postMessage("mutate");
      },
    );

    expect(result.before).toBe(2);
    expect(result.after).toEqual([
      [1, 2, 5],
      [99, 4],
    ]);

    // The main thread sees the worker's nested mutations.
    expect(grid.read()).toEqual([
      [1, 2, 5],
      [99, 4],
    ]);

    stopInit();
  });

  test("a worker can access and mutate nested objects (plain + shared refs)", async () => {
    setDefaultMemory(new SharedMemory());
    await init();

    const inner = Shared<{ label: string }>(
      "m4-nested-obj-inner",
      { label: "deep" },
      { memory: getDefaultMemory() },
    );
    const doc = Shared<{
      profile: { name: string; meta: { level: number } };
      handler: { label: string };
    }>(
      "m4-nested-obj",
      {
        profile: { name: "alpha", meta: { level: 1 } },
        handler: { label: "deep" },
      },
      { memory: getDefaultMemory() },
    );
    (doc as unknown as Record<string, unknown>).handler = inner;

    const workerCode = `
      import { Shared, init, onMessage } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      await init();
      onMessage((e) => {
        if (e.data === "mutate") {
          const doc = Shared("m4-nested-obj", {
            profile: { name: "a", meta: { level: 0 } },
            handler: { label: "d" },
          });
          // Read, then mutate a nested plain object in place.
          const before = doc.profile.meta.level;
          doc.profile.meta.level = 9;
          doc.profile.name = "beta";
          // The live shared ref stays linked to inner.
          const handlerIsInner = doc.handler === Shared("m4-nested-obj-inner", { label: "x" });
          self.postMessage({ before, after: doc.read(), handlerIsInner });
        }
      });
    `;

    const result = await new Promise<{
      before: number;
      after: Record<string, unknown>;
      handlerIsInner: boolean;
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
          | {
              before: number;
              after: Record<string, unknown>;
              handlerIsInner: boolean;
            };
        if (data !== null && typeof data === "object" && "before" in data) {
          resolve(
            data as {
              before: number;
              after: Record<string, unknown>;
              handlerIsInner: boolean;
            },
          );
        }
      };
      worker.postMessage("mutate");
    });

    expect(result.before).toBe(1);
    expect(result.handlerIsInner).toBe(true);
    expect(
      (result.after as { profile: { name: string; meta: { level: number } } })
        .profile,
    ).toEqual({
      name: "beta",
      meta: { level: 9 },
    });
    // A later write to inner is visible through the live shared ref.
    inner.write({ label: "deep2" });
    expect(
      (doc as unknown as { handler: { label: string } }).handler.label,
    ).toBe("deep2");

    stopInit();
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

  test("a worker applies a chunk update broadcast after defragmentation", async () => {
    // Use a small chunk size so writes span multiple chunks in the data tables.
    setDefaultMemory(new SharedMemory({ chunkSize: 4096 }));
    await init();

    const workerCode = `
      import { Shared, init, onMessage, getDefaultMemory } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      await init();
      onMessage((e) => {
        if (e.data === "report") {
          // Report the current chunk sizes so the main thread can verify the
          // worker applied the chunk update.
          self.postMessage({
            arrayChunks: getDefaultMemory().arrayTable.buffers.map(
              (b) => b.byteLength,
            ),
          });
        } else if (e.data === "read") {
          const arr = Shared("m4-gc-0", [0]);
          self.postMessage({ read: arr.read() });
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

    const report = () =>
      new Promise<{ arrayChunks: number[] }>((resolve) => {
        const handler = (e: MessageEvent) => {
          const data = e.data as
            { __sharedMemoryRequest?: boolean } | { arrayChunks: number[] };
          if (
            data !== null &&
            typeof data === "object" &&
            !("__sharedMemoryRequest" in data)
          ) {
            worker.removeEventListener("message", handler);
            resolve(data as { arrayChunks: number[] });
          }
        };
        worker.addEventListener("message", handler);
        worker.postMessage("report");
      });

    const mem = getDefaultMemory();

    // Grow the ArrayTable across several chunks.
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const key = `m4-gc-${i}`;
      keys.push(key);
      Shared(
        key,
        Array.from({ length: 50 }, (_, j) => j),
        { memory: mem },
      );
    }
    const totalChunks = mem.arrayTable.buffers.length;
    expect(totalChunks).toBeGreaterThan(1);

    // Overwrite every array with a tiny one, creating dead space.
    for (let i = 0; i < 100; i++) {
      Shared(keys[i]!, [i], { memory: mem }).write([i]);
    }

    // Defragment, which replaces inactive chunks with fresh 4-byte buffers.
    const result = mem.withLock(() => mem.defragment());
    const inactiveCount = result.arrayTable.filter(
      (sab) => sab.byteLength === 4,
    ).length;
    expect(inactiveCount).toBeGreaterThan(0);

    // Simulate the main thread broadcasting the new chunk lists to the worker
    // (the coordinator does this via onDefragment; here we send it directly).
    worker.postMessage({ __chunkUpdate: true, buffers: result });

    // The worker must now see the replaced chunks.
    const workerReport = await report();
    expect(workerReport.arrayChunks.length).toBe(totalChunks);
    const workerInactive = workerReport.arrayChunks.filter(
      (n) => n === 4,
    ).length;
    expect(workerInactive).toBe(inactiveCount);

    // The worker can still read the compacted data.
    const workerRead = await new Promise<number[]>((resolve) => {
      const handler = (e: MessageEvent) => {
        const data = e.data as
          { __sharedMemoryRequest?: boolean } | { read: number[] };
        if (data !== null && typeof data === "object" && "read" in data) {
          worker.removeEventListener("message", handler);
          resolve(data.read);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage("read");
    });
    expect(workerRead).toEqual([0]);

    worker.terminate();
    stopInit();
  });

  test("a worker appends to a shared object's string property without corrupting it", async () => {
    // Regression test for the shared append-cursor bug: when a worker
    // reconstructs the SharedMemory via fromBuffers(), the per-table append
    // cursor (used length) must be shared, otherwise the worker writes at
    // offset 0 and overwrites existing data (e.g. the key string).
    setDefaultMemory(new SharedMemory({ chunkSize: 1024 }));
    await init();

    const shared = Shared<{ nextId: number; items: string }>("m4-cursor", {
      nextId: 1,
      items: "[]",
    });

    const workerCode = `
      import { Shared, init, onMessage } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      await init();
      onMessage((e) => {
        if (e.data === "append") {
          const shared = Shared("m4-cursor", { nextId: 1, items: "[]" });
          const items = JSON.parse(shared.items);
          items.push({ id: shared.nextId, title: "from-worker" });
          shared.nextId = shared.nextId + 1;
          shared.items = JSON.stringify(items);
          self.postMessage({ items: shared.items });
        }
      });
    `;

    const result = await new Promise<{ items: string }>((resolve) => {
      const worker = new Worker(
        new URL(
          "data:text/javascript," + encodeURIComponent(workerCode),
          import.meta.url,
        ),
        { type: "module" },
      );
      worker.onmessage = (e) => {
        const data = e.data as
          { __sharedMemoryRequest?: boolean } | { items: string };
        if (data !== null && typeof data === "object" && "items" in data) {
          resolve(data as { items: string });
        }
      };
      worker.postMessage("append");
    });

    // The worker appended to the shared string; the main thread sees it.
    expect(JSON.parse(result.items)).toEqual([{ id: 1, title: "from-worker" }]);
    expect(JSON.parse(shared.items)).toEqual([{ id: 1, title: "from-worker" }]);

    // The key is still resolvable (not corrupted by the worker's write).
    expect(shared.nextId).toBe(2);

    stopInit();
  });
});
