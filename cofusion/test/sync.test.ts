import { describe, expect, test } from "bun:test";
import { HyperMutex, HyperNotifier } from "cofusion";

/**
 * Triage tests: confirm cofusion provides the same synchronization primitives
 * (Mutex, Notifier) as bun-shared-memory. Mirrors `test/sync.test.ts`.
 *
 * cofusion's HyperMutex/HyperNotifier are constructed from a raw
 * SharedArrayBuffer + an offset index (they are not standalone like
 * bun-shared-memory's Mutex/Notifier), so we allocate a small buffer and use
 * index 0.
 */

describe("cofusion HyperMutex", () => {
  test("locks and unlocks", () => {
    const m = new HyperMutex(new SharedArrayBuffer(64), 0);
    m.lock();
    m.unlock();
    expect(m.withLock(() => 42)).toBe(42);
  });

  test("is re-entrant", () => {
    const m = new HyperMutex(new SharedArrayBuffer(64), 0);
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
    const mutexBuf = new SharedArrayBuffer(64);
    const counterBuf = new SharedArrayBuffer(4);
    const counter = new Int32Array(counterBuf);
    const WORKERS = 4;
    const INCREMENTS = 1000;

    const workerCode = `
      import { HyperMutex } from "cofusion";
      self.onmessage = (e) => {
        const { mutexBuf, counterBuf, increments } = e.data;
        const mutex = new HyperMutex(mutexBuf, 0);
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
          mutexBuf,
          counterBuf,
          increments: INCREMENTS,
        });
      }
    });

    expect(counter[0]).toBe(WORKERS * INCREMENTS);
  });
});

describe("cofusion HyperNotifier", () => {
  test("wakes a waiting worker", async () => {
    const notifierBuf = new SharedArrayBuffer(64);
    const notifier = new HyperNotifier(notifierBuf, 0);

    const workerCode = `
      import { HyperNotifier } from "cofusion";
      self.onmessage = (e) => {
        const notifier = new HyperNotifier(e.data, 0);
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
      w.postMessage(notifierBuf);
      setTimeout(() => notifier.notify(1), 50);
    });

    expect(result).toBe("ok");
  });
});
