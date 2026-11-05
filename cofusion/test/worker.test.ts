import { describe, expect, test } from "bun:test";
import { createArena, Shared } from "cofusion";

/**
 * Triage tests: confirm cofusion shares data across Bun workers via its
 * `init()` handshake, mirroring `test/worker.test.ts` of bun-shared-memory.
 *
 * cofusion's worker bridge: the main thread creates an arena, the worker calls
 * `await init()` which requests the SharedArrayBuffer from the main thread.
 * The main thread must answer `__HYPERSHM_INIT_REQUEST__` messages with the
 * arena buffer.
 *
 * NOTE: use `addEventListener` (not `onmessage =`) on both the worker and the
 * main thread. Overwriting `onmessage` on the main thread after the handshake
 * races with the worker's `init()` and can drop messages.
 */

/** Spawn a worker that calls cofusion's init() and answers the handshake. */
function spawnCofusionWorker(workerCode: string): Worker {
  return new Worker(
    new URL(
      "data:text/javascript," + encodeURIComponent(workerCode),
      import.meta.url,
    ),
    { type: "module" },
  );
}

/**
 * Wrap a worker with a persistent message listener and a pending-request
 * queue. The worker must post `{ ready: true }` once its `init()` handshake
 * has completed and its message handler is registered. `read()` posts a
 * "read" message and resolves with the worker's reply.
 */
function connectWorker(worker: Worker, arena: { buffer: SharedArrayBuffer }) {
  const pending: Array<(data: { name: string; age: number }) => void> = [];
  let readyResolve: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  worker.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as
      { type?: string; ready?: boolean } | { name: string; age: number };
    if (
      data &&
      (data as { type?: string }).type === "__HYPERSHM_INIT_REQUEST__"
    ) {
      worker.postMessage({
        type: "__HYPERSHM_INIT_RESPONSE__",
        buffer: arena.buffer,
        workerId: 2,
      });
      return;
    }
    if (data && (data as { ready?: boolean }).ready) {
      readyResolve();
      return;
    }
    if (data && "name" in data) {
      const resolve = pending.shift();
      if (resolve) resolve(data as { name: string; age: number });
    }
  });

  return {
    ready,
    read: () =>
      new Promise<{ name: string; age: number }>((resolve) => {
        pending.push(resolve);
        worker.postMessage("read");
      }),
  };
}

describe("cofusion worker integration", () => {
  test("a worker can call Shared() and share data with the main thread", async () => {
    const arena = createArena({ initialSize: 4 * 1024 * 1024 });
    const user = arena.shared("w-user", { name: "Alice", age: 30 });
    expect(user.name).toBe("Alice");

    const workerCode = `
      import { Shared, init } from "cofusion";
      await init();
      self.addEventListener("message", (e) => {
        if (e.data === "read") {
          const u = Shared("w-user", { name: "x", age: 0 });
          self.postMessage({ name: u.name, age: u.age });
        }
      });
      self.postMessage({ ready: true });
    `;

    const worker = spawnCofusionWorker(workerCode);
    const conn = connectWorker(worker, arena);
    await conn.ready;

    expect(await conn.read()).toEqual({ name: "Alice", age: 30 });
    worker.terminate();
  });

  test("a write from the main thread is visible to the worker", async () => {
    const arena = createArena({ initialSize: 4 * 1024 * 1024 });
    const user = arena.shared("w-write", { name: "Alice", age: 30 });

    const workerCode = `
      import { Shared, init } from "cofusion";
      await init();
      self.addEventListener("message", (e) => {
        if (e.data === "read") {
          const u = Shared("w-write", { name: "x", age: 0 });
          self.postMessage({ name: u.name, age: u.age });
        }
      });
      self.postMessage({ ready: true });
    `;

    const worker = spawnCofusionWorker(workerCode);
    const conn = connectWorker(worker, arena);
    await conn.ready;

    expect(await conn.read()).toEqual({ name: "Alice", age: 30 });

    // Main thread writes; the worker must see the new value.
    user.name = "Bob";
    user.age = 31;
    expect(await conn.read()).toEqual({ name: "Bob", age: 31 });

    worker.terminate();
  });

  test("a worker can write and the main thread sees it", async () => {
    const arena = createArena({ initialSize: 4 * 1024 * 1024 });
    const user = arena.shared("w-writeback", { name: "Alice", age: 30 });

    const workerCode = `
      import { Shared, init } from "cofusion";
      await init();
      self.addEventListener("message", (e) => {
        if (e.data === "write") {
          const u = Shared("w-writeback", { name: "x", age: 0 });
          u.name = "FromWorker";
          u.age = 99;
          self.postMessage({ done: true });
        }
      });
      self.postMessage({ ready: true });
    `;

    const worker = spawnCofusionWorker(workerCode);
    const conn = connectWorker(worker, arena);
    await conn.ready;

    // Ask the worker to write, then wait for it to finish.
    worker.postMessage("write");
    await new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        const data = e.data as { done?: boolean };
        if (data && data.done) {
          worker.removeEventListener("message", handler);
          resolve();
        }
      };
      worker.addEventListener("message", handler);
    });

    // The main thread sees the worker's write.
    expect(user.name).toBe("FromWorker");
    expect(user.age).toBe(99);

    worker.terminate();
  });
});
