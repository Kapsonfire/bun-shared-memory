import { describe, expect, test } from "bun:test";
import {
  Notifier,
  RefCountBuffer,
  RefCountCoordinator,
  Shared,
  SharedMemory,
} from "../src/index.ts";

/**
 * Regression tests derived from `review.md` (technical code review).
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
// P1.2 — MPSC ring buffer: concurrent producers must not lose or collide
// events. The current `pushEvent()` reserves the write slot non-atomically
// (read cursor, compute slot, write, publish), so two producers can read the
// same cursor and overwrite each other, or publish a torn slot.
// ---------------------------------------------------------------------------
describe("P1.2 — RefCount ring buffer with multiple producers", () => {
  test("no acquire event is lost or overwritten when several workers push concurrently", async () => {
    const WORKERS = 8;
    const PER_WORKER = 3000; // distinct objectIds written per worker
    // Ring is sized so it never fills (total events = 8*3000 = 24000): any
    // loss below that is therefore a *slot collision*, not a full-queue
    // silent drop. This isolates the non-atomic-reservation bug (P1.2) from
    // the separate full-queue handling concern.
    const RING_SIZE = 1 << 16;
    const buffer = new RefCountBuffer(undefined, {
      ringSize: RING_SIZE,
      maxWorkers: WORKERS + 16,
      maxObjects: WORKERS * PER_WORKER + 16,
    });

    const workerCode = `
        import { RefCountBuffer } from ${JSON.stringify(
          new URL("../src/refcount.ts", import.meta.url).href,
        )};
        self.onmessage = (e) => {
          const sab = e.data.sab;
          const buffer = new RefCountBuffer(sab, { ringSize: ${RING_SIZE}, maxWorkers: ${
            WORKERS + 16
          } });
          const workerId = buffer.allocateWorkerId();
          const perWorker = ${PER_WORKER};
          // Each worker writes globally-unique objectIds (no cross-worker
          // finger in the pie) so any collision or loss is detectable.
          for (let i = 0; i < perWorker; i++) {
            const objectId = workerId * perWorker + i;
            buffer.pushEvent(workerId, 1, objectId);
          }
          self.postMessage("done");
        };
      `;

    await runInWorkers(WORKERS, workerCode, { sab: buffer.sab });

    // Drain everything and count sightings per objectId. Since ids are
    // globally unique, exactly `WORKERS * PER_WORKER` distinct ids must each
    // appear exactly once. Any collision (two writes into one slot) or
    // overwrite shows up as a duplicate or a total count below the expected
    // number of unique ids.
    const seen = new Map<number, number>();
    let ev;
    let n = 0;
    const guard = WORKERS * PER_WORKER + RING_SIZE + 16;
    while ((ev = buffer.popEvent()) !== null && n++ < guard) {
      seen.set(ev.objectId, (seen.get(ev.objectId) ?? 0) + 1);
    }
    // Every objectId a worker wrote must be present exactly once.
    expect(seen.size).toBe(WORKERS * PER_WORKER);
    for (const count of seen.values()) {
      expect(count).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// P1.4 — RefCount multiplicity: a worker holding several references to the
// same objectId. The coordinator tracks `Set<objectId>` per worker, so the
// crash/close path (`releaseWorker`) under-releases: 3 acquires collapse to a
// single global release, leaking the object.
// ---------------------------------------------------------------------------
describe("P1.4 — RefCount multiplicity per worker", () => {
  test("worker close releases every reference, not one per objectId", () => {
    const mem = new SharedMemory();
    const coord = new RefCountCoordinator(mem, undefined, {
      autoMaintenance: false,
    });
    const worker = { onclose: null as (() => void) | null };
    const workerId = coord.registerWorker(worker);

    // A worker that acquired the same objectId three times (e.g. three
    // separate read() copies) holds three references.
    coord.acquire(7, workerId);
    coord.acquire(7, workerId);
    coord.acquire(7, workerId);
    expect(coord.refCount(7)).toBe(3);

    // On close/crash all three references must be released.
    worker.onclose!();
    expect(coord.refCount(7)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P1.3 — Monotonic worker ids overflow the fixed heartbeat/refcount region.
// `allocateWorkerId()` is unbounded, but the heartbeat table holds only
// `maxWorkers` cells; an id >= maxWorkers indexes into the refcount table.
// ---------------------------------------------------------------------------
describe("P1.3 — Worker id boundaries are enforced", () => {
  test("throws a hard error when the worker id pool is exhausted and reuses released ids", () => {
    const MAX_WORKERS = 4;
    const RING_SIZE = 8;
    const MAX_OBJECTS = 16;
    const buffer = new RefCountBuffer(undefined, {
      ringSize: RING_SIZE,
      maxWorkers: MAX_WORKERS,
      maxObjects: MAX_OBJECTS,
    });

    const ids = new Set<number>();
    for (let i = 0; i < MAX_WORKERS; i++) {
      ids.add(buffer.allocateWorkerId());
    }
    // Exhausted: the allocator must fail hard instead of overflowing past
    // maxWorkers.
    expect(() => buffer.allocateWorkerId()).toThrow("worker id pool exhausted");

    // Releasing an id makes room for a new worker to reuse it.
    const released = [...ids][0]!;
    buffer.releaseWorkerId(released);
    const reused = buffer.allocateWorkerId();
    expect(reused).toBe(released);
  });

  test("heartbeat for a workerId beyond maxWorkers does not corrupt the refcount table", () => {
    const MAX_WORKERS = 4;
    const RING_SIZE = 8;
    const MAX_OBJECTS = 16;
    const buffer = new RefCountBuffer(undefined, {
      ringSize: RING_SIZE,
      maxWorkers: MAX_WORKERS,
      maxObjects: MAX_OBJECTS,
    });

    // Recompute the layout exactly as the class does (4 Int32 per event slot,
    // plus a worker-id bitmap of ceil(maxWorkers/32) words).
    const workerBitsOffset = 3 + RING_SIZE * 4;
    const workerBitsWords = Math.ceil(MAX_WORKERS / 32);
    const hbOffset = workerBitsOffset + workerBitsWords;
    const refOffset = hbOffset + MAX_WORKERS;
    const view = new Int32Array(buffer.buffer);

    // Defense-in-depth: even out-of-range ids must not index into the
    // refcount table.
    buffer.heartbeat(MAX_WORKERS + 4);
    buffer.lastHeartbeat(MAX_WORKERS + 4);
    buffer.heartbeat(-1);
    buffer.lastHeartbeat(-1);

    // The refcount table must be untouched by overflowing heartbeats.
    for (let i = 0; i < MAX_OBJECTS; i++) {
      expect(view[refOffset + i]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// P1.1 — Concurrent lock-free writes to the same key are not serialized, so
// concurrent increments lose updates. This documents the current lock-free
// (non-mutually-exclusive) write semantics; a Mutex is required for
// correctness. The test asserts the *intended* serialized result, so it fails
// on the current lock-free semantics — the baseline the write model must meet.
// ---------------------------------------------------------------------------
describe("P1.1 — Concurrent writes to the same shared value", () => {
  test("increments without a Mutex lose updates", async () => {
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
        for (let i = 0; i < increments; i++) {
          const cur = counter.read();
          counter.write(cur + 1);
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

    // With lost updates the final count will be well below the expected total.
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
        const first = notifier.wait(5000);
        const second = notifier.wait(5000);
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
