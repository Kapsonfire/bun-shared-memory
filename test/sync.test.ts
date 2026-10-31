import { describe, expect, test } from "bun:test";
import { Mutex, Notifier, Shared, SharedMemory } from "../src/index.ts";

describe("Mutex", () => {
  test("locks and unlocks", () => {
    const m = new Mutex();
    m.lock();
    m.unlock();
    expect(m.withLock(() => 42)).toBe(42);
  });

  test("is re-entrant", () => {
    const m = new Mutex();
    m.lock();
    // A second acquire from the same thread must not deadlock.
    m.lock();
    m.unlock();
    m.unlock();
    // Re-entrancy through withLock nesting.
    const result = m.withLock(() => m.withLock(() => "nested"));
    expect(result).toBe("nested");
  });

  test("serializes concurrent increments across workers", async () => {
    const mutex = new Mutex();
    const counter = new Int32Array(new SharedArrayBuffer(4));
    const WORKERS = 4;
    const INCREMENTS = 1000;

    const workerCode = `
      import { Mutex } from ${JSON.stringify(
        new URL("../src/mutex.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { mutexBuf, counterBuf, increments } = e.data;
        const mutex = new Mutex(mutexBuf);
        const counter = new Int32Array(counterBuf);
        for (let i = 0; i < increments; i++) {
          mutex.lock();
          counter[0]++;
          mutex.unlock();
        }
        self.postMessage("done");
      };
    `;

    await new Promise<void>((resolve) => {
      let done = 0;
      for (let i = 0; i < WORKERS; i++) {
        const w = new Worker(
          new URL(
            "data:text/javascript," + encodeURIComponent(workerCode),
            import.meta.url,
          ),
          { type: "module" },
        );
        w.onmessage = () => {
          done++;
          if (done === WORKERS) resolve();
        };
        w.postMessage({
          mutexBuf: mutex.buffer,
          counterBuf: counter.buffer,
          increments: INCREMENTS,
        });
      }
    });

    expect(counter[0]).toBe(WORKERS * INCREMENTS);
  });
});

describe("Notifier", () => {
  test("wakes a waiting worker", async () => {
    const notifier = new Notifier();

    const workerCode = `
      import { Notifier } from ${JSON.stringify(
        new URL("../src/notifier.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const notifier = new Notifier(e.data);
        const result = notifier.wait(5000);
        self.postMessage(result);
      };
    `;

    const result = await new Promise<string>((resolve) => {
      const w = new Worker(
        new URL(
          "data:text/javascript," + encodeURIComponent(workerCode),
          import.meta.url,
        ),
        { type: "module" },
      );
      w.onmessage = (e) => resolve(e.data as string);
      w.postMessage(notifier.buffer);
      setTimeout(() => notifier.notify(1), 50);
    });

    expect(result).toBe("ok");
  });
});

describe("Read cache invalidation across workers", () => {
  test("a write in one worker invalidates the read cache in another", async () => {
    const mem = new SharedMemory({ maxByteLength: 64 * 1024 * 1024 });
    const user = Shared(
      "cross-cache-1",
      { name: "Alice", age: 30 },
      { memory: mem },
    );
    expect(user.name).toBe("Alice");

    const workerCode = `
      import { SharedMemory, Mutex, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers, lockBuf, key } = e.data;
        const mem = new SharedMemory({
          lock: new Mutex(lockBuf),
          buffers,
        });
        const user = Shared(key, { name: "Alice", age: 30 }, { memory: mem });
        if (e.data.action === "read") {
          self.postMessage({ name: user.name, age: user.age });
        }
      };
    `;

    const worker = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(workerCode),
        import.meta.url,
      ),
      { type: "module" },
    );

    const readFromWorker = () =>
      new Promise<{ name: string; age: number }>((resolve) => {
        worker.onmessage = (e) =>
          resolve(e.data as { name: string; age: number });
        worker.postMessage({
          action: "read",
          key: "cross-cache-1",
          lockBuf: mem.lock.buffer,
          buffers: {
            indexTable: mem.indexTable.buffer,
            dataTable: mem.dataTable.buffer,
            stringTable: mem.stringTable.buffer,
            arrayTable: mem.arrayTable.buffer,
          },
        });
      });

    // Worker reads and caches the initial value.
    expect(await readFromWorker()).toEqual({ name: "Alice", age: 30 });

    // Main thread writes a new value (bumps the version cell).
    user.name = "Bob";
    user.age = 31;

    // Worker's cache must be invalidated; it must see the new value.
    expect(await readFromWorker()).toEqual({ name: "Bob", age: 31 });

    worker.terminate();
  });
});
