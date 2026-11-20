import { describe, expect, test } from "bun:test";
import {
  Mutex,
  MaintenanceCoordinator,
  Shared,
  SharedMemory,
  getThreadId,
} from "../src/index.ts";
import { LOCK_STRIPES } from "../src/memory.ts";

const SRC = new URL("../src/index.ts", import.meta.url).href;

function spawn(code: string): Worker {
  return new Worker(
    new URL(
      "data:text/javascript," + encodeURIComponent(code),
      import.meta.url,
    ),
    { type: "module" },
  );
}

/** Run `n` workers with the same code; resolve with their replies. */
function runWorkers(
  n: number,
  code: string,
  message: (id: number) => unknown,
  onTick?: () => Promise<void> | void,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const replies: unknown[] = [];
    const workers: Worker[] = [];
    let done = 0;
    for (let id = 0; id < n; id++) {
      const w = spawn(code);
      workers.push(w);
      w.onerror = (e) => reject(e);
      w.onmessage = (e) => {
        replies[id] = e.data;
        if (++done === n) {
          workers.forEach((x) => x.terminate());
          resolve(replies);
        }
      };
      w.postMessage(message(id));
    }
    void onTick;
  });
}

describe("per-key lock stripes", () => {
  test("writers to different keys and to one shared key lose no update", async () => {
    const WORKERS = 4;
    const ROUNDS = 3000;
    const mem = new SharedMemory();
    for (let i = 0; i < WORKERS; i++) {
      Shared(`own-${i}`, { n: 0 }, { memory: mem });
    }
    const counter = Shared("shared-counter", { n: 0 }, { memory: mem });
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(SRC)};
      self.onmessage = (e) => {
        const { buffers, id, rounds } = e.data;
        const mem = SharedMemory.fromBuffers(buffers);
        const own = Shared("own-" + id, { n: -1 }, { memory: mem });
        const shared = Shared("shared-counter", { n: -1 }, { memory: mem });
        for (let i = 1; i <= rounds; i++) {
          own.n = i;
          // Atomic read-modify-write on the contended key.
          shared.update((cur) => ({ n: cur.n + 1 }));
        }
        self.postMessage("done");
      };
    `;
    const buffers = mem.exportBuffers();
    await runWorkers(WORKERS, code, (id) => ({ buffers, id, rounds: ROUNDS }));
    for (let i = 0; i < WORKERS; i++) {
      expect(Shared(`own-${i}`, { n: -1 }, { memory: mem }).n).toBe(ROUNDS);
    }
    expect(counter.n).toBe(WORKERS * ROUNDS);
  }, 30000);

  test("defragmentation under parallel writers keeps every value intact", async () => {
    const WORKERS = 4;
    const ROUNDS = 25000;
    const mem = new SharedMemory();
    // The main thread holds the key (its bit 0 keeps the value block alive
    // during the run); retain the wrappers so they are not collected and do
    // not drop bit 0 mid-write.
    const held: unknown[] = [];
    for (let i = 0; i < WORKERS; i++) {
      held.push(Shared(`frag-${i}`, { s: "", list: [0], n: 0 }, { memory: mem }));
    }
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(SRC)};
      self.onmessage = (e) => {
        const { buffers, id, rounds } = e.data;
        // Bit 0 belongs to the main thread; each worker needs its own holder
        // bit (1..N) so dropping a wrapper here never clears a holder bit the
        // main thread still holds.
        const mem = SharedMemory.fromBuffers({ ...buffers, holderShift: id + 1 });
        const o = Shared("frag-" + id, { s: "", list: [0], n: 0 }, { memory: mem });
        for (let i = 1; i <= rounds; i++) {
          o.s = (id + ":" + i + ":").padEnd(60 + (i % 40), "x"); // churns the heap
          o.list = [i, i + 1, i + 2];
          o.n = i;
        }
        self.postMessage("done");
      };
    `;
    const buffers = mem.exportBuffers();
    let finished = false;
    const done = runWorkers(WORKERS, code, (id) => ({
      buffers,
      id,
      rounds: ROUNDS,
    })).then((r) => {
      finished = true;
      return r;
    });
    // Compact in place again and again while the workers write.
    let passes = 0;
    while (!finished) {
      mem.reclaimInPlace();
      passes++;
      await new Promise((r) => setImmediate(r));
    }
    await done;
    // Make sure the compactions really overlapped with the writers.
    expect(passes).toBeGreaterThan(3);
    // Verify through the wrappers that were held for the whole run. Reading
    // them here is also what keeps them alive during the run: a wrapper that is
    // never referenced again may be collected by a precise GC (finite
    // liveness), which would fire dropKey and clear the main thread's holder
    // bit mid-write. Referencing them after the run makes them genuinely
    // reachable from the init loop onward, so the defrag never drops bit 0.
    for (let id = 0; id < WORKERS; id++) {
      const o = held[id] as any;
      expect(o.n).toBe(ROUNDS);
      expect(o.s).toBe(`${id}:${ROUNDS}:`.padEnd(60 + (ROUNDS % 40), "x"));
      expect([...o.list]).toEqual([ROUNDS, ROUNDS + 1, ROUNDS + 2]);
    }
  }, 60000);

  test("the coordinator releases a stripe held by a dead worker", async () => {
    const mem = new SharedMemory();
    const o = Shared("stripe-key", { n: 0 }, { memory: mem });
    const index = mem.lookupIndex("stripe-key")!;
    let recovered = false;
    const coordinator = new MaintenanceCoordinator(mem, {
      autoMaintenance: false,
      onLockRecovered: () => {
        recovered = true;
      },
    });
    const code = `
      import { SharedMemory, getThreadId } from ${JSON.stringify(SRC)};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data.buffers);
        // Hold this key's stripe forever (the worker is killed below).
        mem.withKeyLock(e.data.index, () => {
          self.postMessage({ threadId: getThreadId() });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        });
      };
    `;
    const worker = spawn(code);
    const workerId = coordinator.registerWorker(worker);
    const threadId = await new Promise<number>((resolve, reject) => {
      worker.onerror = (e) => reject(e);
      worker.onmessage = (e) => resolve(e.data.threadId);
      worker.postMessage({ buffers: mem.exportBuffers(), index });
    });
    coordinator.setWorkerThreadId(workerId, threadId);
    worker.terminate();
    for (let i = 0; i < 200 && !recovered; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(recovered).toBe(true);
    o.n = 42; // would time out if the stripe stayed locked
    expect(o.n).toBe(42);
    coordinator.stopAutoMaintenance();
  }, 20000);

  test("a lock buffer without stripe space degrades to one global lock", () => {
    const mem = new SharedMemory({ lock: new Mutex() }); // plain 12-byte mutex
    const o = Shared("degraded", { n: 0, list: [1] }, { memory: mem });
    for (let i = 0; i < 100; i++) o.n = i;
    o.update((cur) => ({ n: cur.n + 1, list: [...cur.list, 2] }));
    expect(o.n).toBe(100);
    expect(mem.withAllLocks(() => "all locks ok")).toBe("all locks ok");
    mem.reclaimInPlace();
    expect(o.n).toBe(100);
  });

  test("a thread's lock-owner id is stable and non-zero", () => {
    expect(getThreadId()).toBeGreaterThan(0);
    expect(LOCK_STRIPES).toBe(256);
  });
});
