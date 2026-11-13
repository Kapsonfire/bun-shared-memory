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

describe("acceptWorker in Bun", () => {
  const SRC = JSON.stringify(new URL("../src/index.ts", import.meta.url).href);
  // The worker counts the handshake replies it receives (a listener added
  // before init() sees every message), then reports the count and a value.
  const workerCode = `
    import { Shared, init, onMessage } from ${SRC};
    let replies = 0;
    self.addEventListener("message", (e) => {
      if (e.data && e.data.__sharedMemoryInit) replies++;
    });
    await init();
    onMessage((e) => {
      if (e.data === "report") {
        setTimeout(() => {
          self.postMessage({
            replies,
            value: Shared("accept-bun", { n: 0 }).read(),
          });
        }, 50);
      }
    });
    self.postMessage("ping");
  `;
  const spawn = () =>
    new Worker(
      new URL("data:text/javascript," + encodeURIComponent(workerCode)),
      { type: "module" },
    );
  const freshMemory = () => {
    SharedMemory.current()?.dispose();
    return new SharedMemory();
  };
  const report = (worker: Worker) =>
    new Promise<{ replies: number; value: { n: number } }>((resolve) => {
      worker.addEventListener("message", (e) => {
        if (e.data && typeof e.data === "object" && "replies" in e.data) {
          resolve(e.data);
        }
      });
      worker.postMessage("report");
    });

  test("registers a worker manually, without init()'s auto-registration", async () => {
    const mem = freshMemory();
    Shared("accept-bun", { n: 7 });
    const worker = acceptWorker(spawn());
    const got = await report(worker);
    worker.terminate();
    expect(got).toEqual({ replies: 1, value: { n: 7 } });
    mem.dispose();
  });

  test("a worker that init() registered gets one reply, however often it is accepted", async () => {
    const mem = freshMemory();
    await init();
    try {
      Shared("accept-bun", { n: 8 });
      const worker = spawn();
      expect(acceptWorker(worker)).toBe(worker);
      acceptWorker(worker);
      const got = await report(worker);
      worker.terminate();
      expect(got).toEqual({ replies: 1, value: { n: 8 } });
    } finally {
      stopInit();
      mem.dispose();
    }
  });

  test("a worker object without addEventListener: onmessage is wrapped", () => {
    const mem = freshMemory();
    const sent: { __sharedMemoryInit?: boolean }[] = [];
    const seen: unknown[] = [];
    const withHandler = {
      postMessage: (m: unknown) =>
        sent.push(m as { __sharedMemoryInit?: boolean }),
      onmessage: (e: { data: unknown }) => seen.push(e.data) as unknown,
    };
    acceptWorker(withHandler);
    acceptWorker(withHandler); // registered once
    const deliver = (w: { onmessage?: unknown }, data: unknown) =>
      (w.onmessage as (e: { data: unknown }) => void)({ data });
    deliver(withHandler, { __sharedMemoryRequest: true });
    deliver(withHandler, "hello");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.__sharedMemoryInit).toBe(true);
    // The handler that was set keeps getting every message, once.
    expect(seen).toEqual([{ __sharedMemoryRequest: true }, "hello"]);

    // Without a handler set before: the request is still answered.
    const bare: { postMessage: (m: unknown) => void; onmessage?: unknown } = {
      postMessage: (m: unknown) =>
        sent.push(m as { __sharedMemoryInit?: boolean }),
    };
    acceptWorker(bare);
    deliver(bare, { __sharedMemoryRequest: true, threadId: 3 });
    expect(sent).toHaveLength(2);
    mem.dispose();
  });

  test("an onmessage handler set before acceptWorker gets each message once", async () => {
    const mem = freshMemory();
    Shared("accept-bun", { n: 9 });
    const worker = spawn();
    let pings = 0;
    const pinged = new Promise<void>((resolve) => {
      worker.onmessage = (e) => {
        if (e.data === "ping") {
          pings++;
          resolve();
        }
      };
    });
    acceptWorker(worker);
    await pinged;
    const got = await report(worker); // also waits a little for duplicates
    worker.terminate();
    expect(pings).toBe(1);
    expect(got.value).toEqual({ n: 9 });
    mem.dispose();
  });
});
