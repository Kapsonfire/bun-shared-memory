import { describe, expect, test } from "bun:test";
import { Mutex, Notifier } from "../src/index.ts";

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
          new URL("data:text/javascript," + encodeURIComponent(workerCode), import.meta.url),
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
        new URL("data:text/javascript," + encodeURIComponent(workerCode), import.meta.url),
        { type: "module" },
      );
      w.onmessage = (e) => resolve(e.data as string);
      w.postMessage(notifier.buffer);
      setTimeout(() => notifier.notify(1), 50);
    });

    expect(result).toBe("ok");
  });
});
