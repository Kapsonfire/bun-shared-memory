import { describe, expect, test } from "bun:test";
import { Notifier, Shared, SharedMemory } from "../src/index.ts";

/**
 * Regression tests
 *
 * These tests intentionally *reproduce* the concurrency/consistency findings
 * against the current code. Several document current (buggy or unspecified)
 * behaviour and are expected to FAIL until the corresponding fix is
 * implemented — they are the baseline the fixes must turn green.
 */

/**
 * Spawn `workerCount` workers running `workerCode`, post the same `message`
 * to each, and resolve with their replies (in worker order) once all have
 * replied. Workers are terminated after they reply.
 */
function runInWorkers(
  workerCount: number,
  workerCode: string,
  message: unknown,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const results: unknown[] = [];
    let done = 0;
    const url = new URL(
      "data:text/javascript," + encodeURIComponent(workerCode),
      import.meta.url,
    );
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(url, { type: "module" });
      w.onerror = (e) => reject(e);
      w.onmessage = (e: MessageEvent) => {
        results[i] = e.data;
        done++;
        if (done === workerCount) resolve(results);
        w.terminate();
      };
      // Posting after wiring onmessage guarantees the worker is listening.
      w.postMessage(message);
    }
  });
}

// ---------------------------------------------------------------------------
// P1.1 — Concurrent writes to the same shared value: the normal write path was
// lock-free (only taking the shared mutex during defragmentation), so plain
// read-then-write increments could read a stale value and lose updates. Writes
// are now serialized under the shared mutex (see `writeLock`), and a counter
// must use the atomic read-modify-write `update()` — the same atomic RMW the
// write path now provides — so the exact total is preserved.
// ---------------------------------------------------------------------------
describe("P1.1 — Concurrent writes to the same shared value", () => {
  test("atomic increments under the shared mutex lose no updates", async () => {
    const mem = new SharedMemory({ maxByteLength: 64 * 1024 * 1024 });
    Shared<number>("p11-counter", 0, { memory: mem });

    const WORKERS = 4;
    const INCREMENTS = 2000;

    const workerCode = `
      import { SharedMemory, Mutex, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers, lockBuf, key, increments } = e.data;
        const mem = new SharedMemory({ lock: new Mutex(lockBuf), buffers });
        const counter = Shared(key, 0, { memory: mem });
        // Use the atomic read-modify-write (update) so each increment is
        // serialized against the other workers. With plain read-then-write the
        // lock-free read can see a stale value between the two calls and the
        // increment is lost; update holds the shared mutex across the whole
        // read-modify-write (see review.md P1.1).
        for (let i = 0; i < increments; i++) {
          counter.update((cur: number) => cur + 1);
        }
        self.postMessage("done");
      };
    `;

    await runInWorkers(WORKERS, workerCode, {
      buffers: {
        indexTable: mem.indexTable.buffers[0],
        dataTable: mem.dataTable.buffers[0],
        stringTable: mem.stringTable.buffers[0],
        arrayTable: mem.arrayTable.buffers[0],
      },
      lockBuf: mem.lock.buffer,
      key: "p11-counter",
      increments: INCREMENTS,
    });

    // With the writes serialized and atomic RMW increments, no update is lost.
    const counter = Shared<number>("p11-counter", 0, { memory: mem });
    expect(counter.read()).toBe(WORKERS * INCREMENTS);
  });
});

// ---------------------------------------------------------------------------
// P2.1 — Notifier is single-use: after one `notify()` the cell stays 1, so a
// subsequent `wait()` returns "not-equal" immediately instead of blocking.
// ---------------------------------------------------------------------------
describe("P2.1 — Notifier reuse", () => {
  test("a second wait after a notify returns immediately (not-equal)", async () => {
    const notifier = new Notifier();
    const workerCode = `
      import { Notifier } from ${JSON.stringify(
        new URL("../src/notifier.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const notifier = new Notifier(e.data);
        const first = notifier.wait(1500);
        const second = notifier.wait(1500);
        self.postMessage({ first, second });
      };
    `;

    const result = await new Promise<{ first: string; second: string }>(
      (resolve) => {
        const w = new Worker(
          new URL(
            "data:text/javascript," + encodeURIComponent(workerCode),
            import.meta.url,
          ),
          { type: "module" },
        );
        w.onmessage = (e) =>
          resolve(e.data as { first: string; second: string });
        w.postMessage(notifier.buffer);
        // Notify shortly after the worker starts its first wait.
        setTimeout(() => notifier.notify(1), 50);
      },
    );

    expect(result.first).toBe("ok");
    // A reusable notifier should block on the second wait until the next
    // notify(); the current single-shot implementation returns immediately.
    expect(result.second).toBe("timed-out");
  });
});
