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
    Shared<number>("rw-counter", 0, { memory: mem });

    const WORKERS = 4;
    const INCREMENTS = 2000;

    const workerCode = `
      import { SharedMemory, Mutex, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers, key, increments } = e.data;
        const mem = new SharedMemory({ lock: new Mutex(buffers.lockBuf), buffers });
        const counter = Shared(key, 0, { memory: mem });
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
        lockBuf: mem.lock.buffer,
      },
      key: "rw-counter",
      increments: INCREMENTS,
    });

    const counter = Shared<number>("rw-counter", 0, { memory: mem });
    expect(counter.read()).toBe(WORKERS * INCREMENTS);
  });

  test("withReadLock returns the callback result on a Shared value", () => {
    const obj = Shared<number>("rw-readonly", 42);

    // Callback receives the wrapper as an argument (per the API signature).
    const read = obj.withReadLock((self) => self.read());
    expect(read).toBe(42);

    obj.withWriteLock((self) => self.write(43));
    expect(obj.withReadLock((self) => self.read())).toBe(43);
    expect(obj.read()).toBe(43);
  });

  test("a held withReadLock blocks a read in another worker until release", async () => {
    const mem = new SharedMemory({ maxByteLength: 64 * 1024 * 1024 });
    const obj = Shared<object>("rw-obj", { val: 1 }, { memory: mem });

    // Coordination cells (raw Atomics, independent of the library's Notifier):
    // control[0] = value read by the blocking reader (must end up 99)
    const control = new Int32Array(new SharedArrayBuffer(8));
    // held[0] = set by writer once its read lock is acquired
    const held = new Int32Array(new SharedArrayBuffer(8));

    const writerCode = `
      import { SharedMemory, Mutex, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers } = e.data;
        const mem = new SharedMemory({ lock: new Mutex(buffers.lockBuf), buffers });
        const o = Shared("rw-obj", { val: 1 }, { memory: mem });
        const held = new Int32Array(buffers.heldBuf);
        const gate = new Int32Array(buffers.gateBuf);
        o.withReadLock(() => {
          // Signal that the read lock is held, then hold it long enough that a
          // reader started from the main thread is guaranteed to try reading
          // while the lock is still held (Atomics.wait timeout releases us).
          Atomics.store(held, 0, 1);
          Atomics.notify(held, 0);
          Atomics.wait(gate, 0, 0, 200);
          // Mutate only at the very end of the lock, just before releasing.
          o.val = 99;
        });
        self.postMessage("done");
      };
    `;

    const readerCode = `
      import { SharedMemory, Mutex, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers } = e.data;
        const mem = new SharedMemory({ lock: new Mutex(buffers.lockBuf), buffers });
        const o = Shared("rw-obj", { val: 1 }, { memory: mem });
        const control = new Int32Array(buffers.controlBuf);
        // Must block until the writer releases its read lock. If it read too
        // early it would see 1; only after release would it see the 99 the
        // writer wrote inside the lock.
        const v = o.val;
        Atomics.store(control, 0, v);
        self.postMessage("done");
      };
    `;

    const url = (code: string) =>
      new URL(
        "data:text/javascript," + encodeURIComponent(code),
        import.meta.url,
      );

    const buffers = {
      indexTable: mem.indexTable.buffers[0],
      dataTable: mem.dataTable.buffers[0],
      stringTable: mem.stringTable.buffers[0],
      arrayTable: mem.arrayTable.buffers[0],
      lockBuf: mem.lock.buffer,
      controlBuf: control.buffer,
      heldBuf: held.buffer,
      gateBuf: new SharedArrayBuffer(8),
    };

    // Start the writer; it acquires the read lock and signals "held" via the
    // shared cell. Wait for that signal (not for the writer's postMessage,
    // which only fires after the lock is fully released).
    const writer = new Worker(url(writerCode), { type: "module" });
    writer.postMessage({ buffers });
    await new Promise<void>((res) => {
      const poll = () => {
        if (Atomics.load(held, 0) === 1) res();
        else setTimeout(poll, 2);
      };
      poll();
    });

    // Start the reader while the read lock is still held; on release it must
    // observe the value written inside the lock (99).
    const reader = new Worker(url(readerCode), { type: "module" });
    await new Promise<void>((res) => {
      reader.onmessage = () => res();
      reader.postMessage({ buffers });
    });
    writer.terminate();
    reader.terminate();

    expect(Atomics.load(control, 0)).toBe(99);
  });
});

describe("RWLock write re-entry and hand-off", () => {
  const writerBit = (lock: RWLock) => new Int32Array(lock.buffer)[0]! & 1;

  test("a nested write lock keeps the lock until the outermost unlock", () => {
    const lock = new RWLock();
    lock.writeLock();
    lock.writeLock();
    lock.writeUnlock();
    expect(writerBit(lock)).toBe(1); // still held by the outer lock
    lock.writeUnlock();
    expect(writerBit(lock)).toBe(0);
  });

  test("withWriteLock returns the result and releases on exceptions", () => {
    const lock = new RWLock();
    expect(lock.withWriteLock(() => lock.withWriteLock(() => 7))).toBe(7);
    expect(writerBit(lock)).toBe(0);
    expect(() =>
      lock.withWriteLock(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(writerBit(lock)).toBe(0);
    lock.withReadLock(() => undefined); // free again
  });

  test("a waiting writer takes over when the holder in another worker releases", async () => {
    const lock = new RWLock();
    const code = `
      import { RWLock } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const lock = new RWLock(e.data);
        lock.writeLock();
        self.postMessage("locked");
        const end = performance.now() + 150;
        while (performance.now() < end) {}
        lock.writeUnlock();
      };`;
    const worker = new Worker(
      new URL("data:text/javascript," + encodeURIComponent(code)),
      { type: "module" },
    );
    await new Promise<void>((resolve) => {
      worker.onmessage = () => resolve();
      worker.postMessage(lock.buffer);
    });
    const started = performance.now();
    lock.writeLock(); // queues behind the worker, then takes over
    const waited = performance.now() - started;
    expect(writerBit(lock)).toBe(1);
    lock.writeUnlock();
    worker.terminate();
    expect(waited).toBeGreaterThan(50);
    expect(new Int32Array(lock.buffer)[0]).toBe(0);
  });
});
