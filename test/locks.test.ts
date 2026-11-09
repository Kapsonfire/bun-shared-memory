import { afterEach, describe, expect, test } from "bun:test";
import {
  LockTimeoutError,
  Mutex,
  RWLock,
  RefCountCoordinator,
  Shared,
  SharedMemory,
  getDefaultLockTimeout,
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

describe("budget exhaustion", () => {
  const big = () => new Array(1000).fill(1) as number[];

  test("without a coordinator the budget error surfaces", () => {
    const mem = new SharedMemory({
      maxTotalBytes: 32 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
    });
    const o = Shared("budget-plain", { list: big() }, { memory: mem }) as {
      list: number[];
    };
    expect(() => {
      for (let i = 0; i < 20000; i++) o.list = big();
    }).toThrow(BudgetExceededError);
  });

  test("a coordinator reclaims dead space on demand and the write succeeds", () => {
    const mem = new SharedMemory({
      maxTotalBytes: 32 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
    });
    const coordinator = new RefCountCoordinator(mem, undefined, {
      autoMaintenance: false,
    });
    const o = Shared(
      "budget-reclaim",
      { list: big(), n: 0 },
      { memory: mem },
    ) as {
      list: number[];
      n: number;
    };
    for (let i = 0; i < 20000; i++) {
      o.list = big();
      o.n = i;
    }
    expect(o.n).toBe(19999);
    expect(o.list.length).toBe(1000);
    expect(o.list[999]).toBe(1);
    coordinator.stopAutoMaintenance();
  });
});
