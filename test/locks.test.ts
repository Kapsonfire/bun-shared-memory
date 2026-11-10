import { afterEach, describe, expect, test } from "bun:test";
import {
  LockTimeoutError,
  Mutex,
  RWLock,
  MaintenanceCoordinator,
  Shared,
  SharedMemory,
  StripeLock,
  getDefaultLockTimeout,
  getThreadId,
  setDefaultLockTimeout,
} from "../src/index.ts";
import { BudgetExceededError } from "../src/growable-buffer.ts";

/**
 * Start a worker that takes `acquire` on the primitive and then holds it
 * forever (a "crashed" lock holder). Resolves once the lock is held.
 */
function holdForever(
  module: string,
  body: string,
  buf: SharedArrayBuffer,
): Promise<Worker> {
  const code = `
    import { ${module} } from ${JSON.stringify(
      new URL(`../src/${module.toLowerCase()}.ts`, import.meta.url).href,
    )};
    self.onmessage = (e) => {
      const lock = new ${module}(e.data);
      ${body}
      self.postMessage("held");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
  `;
  return new Promise((resolve, reject) => {
    const w = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(code),
        import.meta.url,
      ),
      { type: "module" },
    );
    w.onerror = (e) => reject(e);
    w.onmessage = () => resolve(w);
    w.postMessage(buf);
  });
}

describe("StripeLock (per-thread depth, shared owner)", () => {
  const region = () => new SharedArrayBuffer(64);

  test("is re-entrant and publishes/clears its owner in the shared cell", () => {
    const lock = new StripeLock(region());
    expect(lock.owner).toBe(0);
    lock.lock();
    expect(lock.owner).toBe(getThreadId());
    expect(lock.heldByCurrentThread).toBe(true);
    lock.lock(); // re-entrant
    lock.unlock();
    expect(lock.owner).toBe(getThreadId()); // still held once
    lock.unlock();
    expect(lock.owner).toBe(0);
    expect(lock.heldByCurrentThread).toBe(false);
  });

  test("unlock without lock is rejected", () => {
    expect(() => new StripeLock(region()).unlock()).toThrow();
  });

  test("a held stripe can be force-released by its owner id", () => {
    const sab = region();
    const lock = new StripeLock(sab);
    lock.lock();
    const other = new StripeLock(sab, { timeoutMs: 100 });
    expect(() => other.lock()).toThrow(LockTimeoutError);
    expect(other.forceUnlock(getThreadId())).toBe(true);
    other.lock(); // free again
    other.unlock();
  });

  test("withLock releases on exceptions", () => {
    const lock = new StripeLock(region());
    expect(() =>
      lock.withLock(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(lock.owner).toBe(0);
  });
});

describe("Mutex re-entrancy and ownership", () => {
  test("two instances over the same buffer share re-entrancy", () => {
    const a = new Mutex();
    const b = new Mutex(a.buffer);
    a.lock();
    // Would deadlock (until the timeout) if `b` did not see that this thread
    // already holds the lock.
    b.lock();
    expect(a.heldByCurrentThread).toBe(true);
    b.unlock();
    expect(b.owner).not.toBe(0);
    a.unlock();
    expect(a.owner).toBe(0);
    expect(b.heldByCurrentThread).toBe(false);
  });

  test("unlock by a non-owner is rejected", () => {
    const m = new Mutex();
    expect(() => m.unlock()).toThrow();
  });

  test("legacy 4-byte buffers still work and stay re-entrant", () => {
    const m = new Mutex(new SharedArrayBuffer(4));
    expect(m.withLock(() => m.withLock(() => "ok"))).toBe("ok");
  });

  test("a release racing with the waiter marking leaves a claimable cell", () => {
    // The state a waiter can leave behind: the owner released between the
    // waiter's failed acquire and its `Atomics.or`, so the cell carries only
    // the waiter bit. Any acquire must be able to claim it — nobody will ever
    // store 0 into it again, so waiting on it would hang until the timeout.
    const sab = new SharedArrayBuffer(8);
    const cell = new Int32Array(sab);
    cell[0] = 0x80000000 | 0;
    const m = new Mutex(sab);
    m.lock();
    expect(m.owner).toBe(getThreadId());
    m.unlock();
    expect(m.owner).toBe(0);
  });
});

describe("lock timeouts", () => {
  const saved = getDefaultLockTimeout();
  afterEach(() => setDefaultLockTimeout(saved));

  test("Mutex: a dead holder cannot hang waiters; forceUnlock recovers", async () => {
    const m = new Mutex();
    const w = await holdForever("Mutex", "lock.lock();", m.buffer);
    const waiter = new Mutex(m.buffer, { timeoutMs: 150 });
    const t = performance.now();
    expect(() => waiter.lock()).toThrow(LockTimeoutError);
    expect(performance.now() - t).toBeLessThan(2000);

    const owner = m.owner;
    expect(owner).not.toBe(0);
    w.terminate();
    expect(waiter.forceUnlock(owner)).toBe(true);
    expect(waiter.withLock(() => "recovered")).toBe("recovered");
    // A stale owner id must not unlock someone else's lock.
    expect(waiter.forceUnlock(owner)).toBe(false);
  });

  test("RWLock: reader and writer time out behind a dead writer", async () => {
    const l = new RWLock();
    const w = await holdForever("RWLock", "lock.writeLock();", l.buffer);
    const t = new RWLock(l.buffer, { timeoutMs: 100 });
    expect(() => t.readLock()).toThrow(LockTimeoutError);
    expect(() => t.writeLock()).toThrow(LockTimeoutError);
    w.terminate();
  });

  test("RWLock: a timed-out writer does not leave readers blocked", () => {
    const l = new RWLock();
    l.readLock(); // this thread holds a read lock
    // A second RWLock instance has its own (per-thread) depth bookkeeping,
    // so it behaves like another thread: it cannot take the write lock...
    const other = new RWLock(l.buffer, { timeoutMs: 100 });
    expect(() => other.writeLock()).toThrow(LockTimeoutError);
    // ...and must not leave the WRITES_QUEUED bit behind for new readers.
    const reader = new RWLock(l.buffer, { timeoutMs: 100 });
    expect(() => reader.readLock()).not.toThrow();
    reader.readUnlock();
    l.readUnlock();
  });

  test("object seqlock: a stuck lock bit makes reads time out", () => {
    const mem = new SharedMemory();
    const ref = Shared("stuck", { a: 1 }, { memory: mem });
    const index = mem.lookupIndex("stuck")!;
    const cell = mem.getVersionCellIndex(index);
    setDefaultLockTimeout(100);
    Atomics.or(mem.versionView, cell, 0x1); // WRITER bit, never cleared
    // Read through a fresh view so the cached value cannot satisfy it.
    expect(() => (ref as { a: number }).a).toThrow(LockTimeoutError);
    Atomics.and(mem.versionView, cell, ~0x1);
    expect((ref as { a: number }).a).toBe(1);
  });
});

describe("browser main thread (no Atomics.wait)", () => {
  test("lock waits fall back to a bounded busy-wait", async () => {
    // Simulate the browser main thread in a worker: `window` + `document`
    // exist and Atomics.wait throws, exactly as it does there.
    const code = `
      globalThis.window = {};
      globalThis.document = {};
      Atomics.wait = () => {
        throw new TypeError("Atomics.wait cannot be called in this context");
      };
      const { Mutex } = await import(${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )});
      self.onmessage = (e) => {
        const { step, buf } = e.data;
        try {
          if (step === 1) new Mutex(buf, { timeoutMs: 100 }).lock();
          else { const m = new Mutex(buf, { timeoutMs: 5000 }); m.lock(); m.unlock(); }
          self.postMessage({ step, result: "acquired" });
        } catch (err) {
          self.postMessage({ step, result: err.name });
        }
      };
      self.postMessage({ step: 0, result: "ready" });
    `;
    const worker = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(code),
        import.meta.url,
      ),
      { type: "module" },
    );
    const next = () =>
      new Promise<{ step: number; result: string }>((resolve, reject) => {
        worker.onerror = (e) => reject(e);
        worker.onmessage = (e) => resolve(e.data);
      });
    expect((await next()).result).toBe("ready");

    const m = new Mutex();
    m.lock(); // held by this (main) thread
    let reply = next();
    worker.postMessage({ step: 1, buf: m.buffer });
    // The wait is bounded: a LockTimeoutError, not the TypeError from wait().
    expect((await reply).result).toBe("LockTimeoutError");

    // Released while the worker busy-waits: it acquires.
    reply = next();
    worker.postMessage({ step: 2, buf: m.buffer });
    await new Promise((r) => setTimeout(r, 100));
    m.unlock();
    expect((await reply).result).toBe("acquired");
    worker.terminate();
  }, 15000);
});

describe("budget exhaustion", () => {
  const big = () => new Array(1000).fill(1) as number[];
  const smallMemory = () =>
    new SharedMemory({
      maxTotalBytes: 32 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
    });

  test("a standalone memory reclaims dead space in place and the write succeeds", () => {
    const mem = smallMemory();
    const o = Shared("budget-plain", { list: big(), n: 0 }, { memory: mem });
    // ~320 MB of overwritten arrays against a 32 MiB budget.
    for (let i = 0; i < 20000; i++) {
      o.list = big();
      o.n = i;
    }
    expect(o.n).toBe(19999);
    expect(o.list.length).toBe(1000);
  });

  test("the budget error still surfaces when live data really fills it", () => {
    const mem = smallMemory();
    expect(() => {
      for (let i = 0; i < 20000; i++) {
        Shared(`budget-live-${i}`, { list: big() }, { memory: mem });
      }
    }).toThrow(BudgetExceededError);
  });

  test("a coordinator reclaims dead space on demand and the write succeeds", () => {
    const mem = smallMemory();
    const coordinator = new MaintenanceCoordinator(mem, {
      autoMaintenance: false,
    });
    const o = Shared("budget-reclaim", { list: big(), n: 0 }, { memory: mem });
    for (let i = 0; i < 20000; i++) {
      o.list = big();
      o.n = i;
    }
    expect(o.n).toBe(19999);
    expect(o.list.length).toBe(1000);
    expect(o.list[999]).toBe(1);
    coordinator.stopAutoMaintenance();
  });

  test("a worker thread reclaims dead space on its own", async () => {
    const mem = smallMemory();
    const o = Shared("budget-worker", { list: big(), n: 0 }, { memory: mem });
    const buffers = mem.exportBuffers();
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data);
        const o = Shared("budget-worker", { list: [], n: -1 }, { memory: mem });
        try {
          for (let i = 0; i < 20000; i++) {
            o.list = new Array(1000).fill(2);
            o.n = i;
          }
          self.postMessage({ ok: true });
        } catch (err) {
          self.postMessage({ ok: false, error: String(err) });
        }
      };
    `;
    const worker = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(code),
        import.meta.url,
      ),
      { type: "module" },
    );
    const reply = await new Promise<{ ok: boolean; error?: string }>(
      (resolve, reject) => {
        worker.onerror = (e) => reject(e);
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage(buffers);
      },
    );
    worker.terminate();
    expect(reply).toEqual({ ok: true });
    // The main thread sees the worker's last write after its compaction.
    expect(o.n).toBe(19999);
    expect(o.list.length).toBe(1000);
    expect(o.list[0]).toBe(2);
  }, 30000);
});

describe("automatic lock recovery", () => {
  test("the coordinator releases the mutex of a worker that died holding it", async () => {
    const mem = new SharedMemory();
    let recovered = null as { workerId: number; threadId: number } | null;
    const coordinator = new MaintenanceCoordinator(mem, {
      autoMaintenance: false,
      onLockRecovered: (workerId, threadId) => {
        recovered = { workerId, threadId };
      },
    });
    const code = `
      import { SharedMemory, getThreadId } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data);
        mem.lock.lock(); // never released: the worker is terminated below
        self.postMessage({ threadId: getThreadId() });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
    `;
    const worker = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(code),
        import.meta.url,
      ),
      { type: "module" },
    );
    const workerId = coordinator.registerWorker(worker);
    const threadId = await new Promise<number>((resolve, reject) => {
      worker.onerror = (e) => reject(e);
      worker.onmessage = (e) => resolve(e.data.threadId);
      worker.postMessage(mem.exportBuffers());
    });
    coordinator.setWorkerThreadId(workerId, threadId);
    expect(mem.lock.owner).toBe(threadId);

    worker.terminate();
    for (let i = 0; i < 200 && recovered === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(recovered).toEqual({ workerId, threadId });
    expect(mem.lock.owner).toBe(0);
    expect(mem.withLock(() => "free again")).toBe("free again");
    coordinator.stopAutoMaintenance();
  }, 15000);
});
