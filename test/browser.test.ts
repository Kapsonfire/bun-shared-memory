import { describe, expect, test } from "bun:test";
import {
  Shared,
  SharedMemory,
  acceptWorker,
  getDefaultMemory,
  init,
  isBun,
  isMainThread,
  isWorkerContext,
  onMessage,
  setDefaultMemory,
  spawnWorker,
  stopInit,
} from "../src/index.ts";
import { supportsWorkerEvents } from "../src/env.ts";

describe("Browser / environment compatibility", () => {
  test("env detection exports sane booleans in Bun main thread", () => {
    expect(typeof isBun).toBe("boolean");
    expect(typeof isMainThread).toBe("boolean");
    expect(typeof isWorkerContext).toBe("boolean");
    expect(typeof supportsWorkerEvents).toBe("boolean");
    // In a Bun test main thread we are Bun, on the main thread, not a worker.
    expect(isBun).toBe(true);
    expect(isMainThread).toBe(true);
    expect(isWorkerContext).toBe(false);
    expect(supportsWorkerEvents).toBe(true);
  });

  test("acceptWorker is exported and returns the worker unchanged", async () => {
    setDefaultMemory(new SharedMemory());
    await init();
    try {
      const workerCode = `
        import { Shared, init, onMessage } from ${JSON.stringify(
          new URL("../src/index.ts", import.meta.url).href,
        )};
        await init();
        onMessage((e) => {
          if (e.data === "read") {
            const user = Shared("browser-spawn", { name: "x" });
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

      // Must be callable and return the same worker for chaining.
      expect(acceptWorker(worker)).toBe(worker);

      const read = await new Promise<{ name: string }>((resolve) => {
        worker.onmessage = (e) => {
          const data = e.data as
            { __sharedMemoryRequest?: boolean } | { name: string };
          if (!("__sharedMemoryRequest" in data)) {
            resolve(data as { name: string });
          }
        };
        worker.postMessage("read");
      });
      expect(read).toEqual({ name: "x" });

      worker.terminate();
    } finally {
      stopInit();
    }
  });

  test("spawnWorker creates a worker that shares data with the main thread", async () => {
    setDefaultMemory(new SharedMemory());
    await init();
    try {
      const counter = Shared("browser-spawn-counter", { value: 0 });

      const workerCode = `
        import { Shared, init, onMessage } from ${JSON.stringify(
          new URL("../src/index.ts", import.meta.url).href,
        )};
        await init();
        onMessage((e) => {
          if (e.data === "inc") {
            const c = Shared("browser-spawn-counter", { value: 0 });
            c.write({ value: c.read().value + 1 });
            self.postMessage(c.read());
          }
        });
      `;

      const worker = spawnWorker(
        new URL(
          "data:text/javascript," + encodeURIComponent(workerCode),
          import.meta.url,
        ),
        { type: "module" },
      );

      const got = await new Promise<{ value: number }>((resolve) => {
        worker.onmessage = (e) => {
          const data = e.data as
            { __sharedMemoryRequest?: boolean } | { value: number };
          if (!("__sharedMemoryRequest" in data)) {
            resolve(data as { value: number });
          }
        };
        worker.postMessage("inc");
      });

      expect(got).toEqual({ value: 1 });
      // Main thread sees the same shared counter.
      expect(counter.read()).toEqual({ value: 1 });

      worker.terminate();
    } finally {
      stopInit();
    }
  });

  test("getDefaultMemory singleton is unaffected by spawn/accept helpers", () => {
    setDefaultMemory(new SharedMemory());
    expect(getDefaultMemory()).toBe(getDefaultMemory());
  });
});
