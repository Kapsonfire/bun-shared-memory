import { describe, expect, test } from "bun:test";
import { Mutex, RWLock, Shared, SharedMemory } from "../src/index.ts";

/**
 * V2 RW-Lock tests.
 *
 * The `RWLock` (src/rwlock.ts) stores its state in one Int32 cell of a
 * SharedArrayBuffer (bit 0 = WRITER, bit 1 = WRITES_QUEUED, high bits =
 * reader count). Any number of readers may hold it at once; writers are
 * exclusive. These tests verify the core semantics directly and through a
 * `Shared` wrapper via `withRWLock` / `withReadLock` / `withWriteLock`.
 */

/** Spawn `workerCount` workers running `workerCode`, post the same `message`
 * to each, resolve once all have replied. */
function runInWorkers(
  workerCount: number,
  workerCode: string,
  message: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = 0;
    const url = new URL(
      "data:text/javascript," + encodeURIComponent(workerCode),
      import.meta.url,
    );
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(url, { type: "module" });
      w.onerror = (e) => reject(e);
      w.onmessage = () => {
        done++;
        if (done === workerCount) resolve();
        w.terminate();
      };
      w.postMessage(message);
    }
  });
}

// ---------------------------------------------------------------------------
// RWLock core semantics
// ---------------------------------------------------------------------------
describe("RWLock", () => {
  test("allows many concurrent readers", async () => {
    const WORKERS = 6;
    const TURNS = 4000;
    // [0] = active readers, [1] = max concurrent readers seen
    const state = new Int32Array(new SharedArrayBuffer(2 * 4));
    const lock = new RWLock();

    const workerCode = `
      import { RWLock } from ${JSON.stringify(
        new URL("../src/rwlock.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { sab, lockBuf, turns } = e.data;
        const state = new Int32Array(sab);
        const lock = new RWLock(lockBuf);
        for (let i = 0; i < turns; i++) {
          lock.withReadLock(() => {
            const active = Atomics.add(state, 0, 1) + 1;
            Atomics.store(state, 1, Math.max(Atomics.load(state, 1), active));
            Atomics.sub(state, 0, 1);
          });
        }
        self.postMessage("done");
      };
    `;

    await runInWorkers(WORKERS, workerCode, {
      sab: state.buffer,
      lockBuf: lock.buffer,
      turns: TURNS,
    });

    // Several readers held the lock simultaneously (parallel readers).
    expect(Atomics.load(state, 1)).toBeGreaterThan(1);
    // All readers released.
    expect(Atomics.load(state, 0)).toBe(0);
  });

  test("never allows two concurrent writers (mutual exclusion)", async () => {
    const WORKERS = 6;
    const TURNS = 4000;
    // [0] = max concurrent writers seen, [1] = active writers
    const state = new Int32Array(new SharedArrayBuffer(2 * 4));
    const lock = new RWLock();

    const workerCode = `
      import { RWLock } from ${JSON.stringify(
        new URL("../src/rwlock.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { sab, lockBuf, turns } = e.data;
        const state = new Int32Array(sab);
        const lock = new RWLock(lockBuf);
        for (let i = 0; i < turns; i++) {
          lock.withWriteLock(() => {
            const active = Atomics.add(state, 1, 1) + 1;
            Atomics.store(state, 0, Math.max(Atomics.load(state, 0), active));
            Atomics.sub(state, 1, 1);
          });
        }
        self.postMessage("done");
      };
    `;

    await runInWorkers(WORKERS, workerCode, {
      sab: state.buffer,
      lockBuf: lock.buffer,
      turns: TURNS,
    });

    // Writers are mutually exclusive: never more than one active.
    expect(Atomics.load(state, 0)).toBe(1);
  });

  test("is re-entrant on the same thread", () => {
    const lock = new RWLock();
    lock.readLock();
    lock.readLock(); // nested read on the same thread
    lock.readUnlock();
    lock.readUnlock();

    lock.writeLock();
    lock.withReadLock(() => {}); // read inside a write hold (downgrade) is safe
    lock.writeUnlock();
  });

  test("rejects a read-to-write upgrade from the same thread", () => {
    const lock = new RWLock();
    lock.readLock();
    expect(() => lock.writeLock()).toThrow(/cannot upgrade a read lock/i);
    lock.readUnlock();
  });

  test("serializes read-modify-write without lost updates", async () => {
    const WORKERS = 4;
    const INCREMENTS = 2000;
    // [0] = counter
    const state = new Int32Array(new SharedArrayBuffer(1 * 4));
    const lock = new RWLock();

    const workerCode = `
      import { RWLock } from ${JSON.stringify(
        new URL("../src/rwlock.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { sab, lockBuf, increments } = e.data;
        const state = new Int32Array(sab);
        const lock = new RWLock(lockBuf);
        for (let i = 0; i < increments; i++) {
          lock.withWriteLock(() => {
            Atomics.add(state, 0, 1);
          });
        }
        self.postMessage("done");
      };
    `;

    await runInWorkers(WORKERS, workerCode, {
      sab: state.buffer,
      lockBuf: lock.buffer,
      increments: INCREMENTS,
    });

    expect(Atomics.load(state, 0)).toBe(WORKERS * INCREMENTS);
  });
});

// ---------------------------------------------------------------------------
// Shared + withRWLock / withReadLock integration
// ---------------------------------------------------------------------------
describe("RWLock integration with Shared", () => {
  test("withRWLock serializes concurrent RMW across workers", async () => {
    const mem = new SharedMemory({ maxByteLength: 64 * 1024 * 1024 });
    const rwLock = new RWLock();
    Shared<number>("rw-counter", 0, { memory: mem, rwLock });

    const WORKERS = 4;
    const INCREMENTS = 2000;

    const workerCode = `
      import { SharedMemory, Mutex, RWLock, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers, lockBuf, rwLockBuf, key, increments } = e.data;
        const mem = new SharedMemory({ lock: new Mutex(lockBuf), buffers });
        const rwLock = new RWLock(rwLockBuf);
        const counter = Shared(key, 0, { memory: mem, rwLock });
        for (let i = 0; i < increments; i++) {
          counter.withRWLock(() => {
            counter.write(counter.read() + 1);
          });
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
      rwLockBuf: rwLock.buffer,
      key: "rw-counter",
      increments: INCREMENTS,
    });

    const counter = Shared<number>("rw-counter", 0, { memory: mem, rwLock });
    expect(counter.read()).toBe(WORKERS * INCREMENTS);
  });

  test("withReadLock returns the callback result on a Shared value", () => {
    const rwLock = new RWLock();
    const obj = Shared<number>("rw-readonly", 42, { rwLock });

    // Callback receives the wrapper as an argument (per the API signature).
    const read = obj.withReadLock((self) => self.read());
    expect(read).toBe(42);

    obj.withWriteLock((self) => self.write(43));
    expect(obj.withReadLock((self) => self.read())).toBe(43);
    expect(obj.read()).toBe(43);
  });
});
