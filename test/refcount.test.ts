import { describe, expect, test } from "bun:test";
import {
  RefCountBuffer,
  RefCountCoordinator,
  RefCountTracker,
  Shared,
  SharedMemory,
} from "../src/index.ts";

describe("RefCountBuffer", () => {
  test("queues and pops acquire/release events", () => {
    const buf = new RefCountBuffer();
    buf.pushEvent(0, 1, 42);
    buf.pushEvent(0, 0, 7);
    expect(buf.popEvent()).toEqual({ workerId: 0, op: 1, objectId: 42 });
    expect(buf.popEvent()).toEqual({ workerId: 0, op: 0, objectId: 7 });
    expect(buf.popEvent()).toBeNull();
  });

  test("tracks global refcounts", () => {
    const buf = new RefCountBuffer();
    expect(buf.refCount(5)).toBe(0);
    buf.acquireGlobal(5);
    buf.acquireGlobal(5);
    expect(buf.refCount(5)).toBe(2);
    // Atomics.sub returns the value before the decrement.
    expect(buf.releaseGlobal(5)).toBe(2);
    expect(buf.releaseGlobal(5)).toBe(1);
    expect(buf.refCount(5)).toBe(0);
  });

  test("updates and reads heartbeats", () => {
    const buf = new RefCountBuffer();
    buf.heartbeat(0);
    expect(buf.lastHeartbeat(0)).toBeGreaterThan(0);
  });
});

describe("RefCountCoordinator", () => {
  test("tracks which worker holds a reference", () => {
    const mem = new SharedMemory();
    const coord = new RefCountCoordinator(mem);
    const workerId = coord.registerWorker({});
    coord.acquire(1, workerId);
    expect(coord.refCount(1)).toBe(1);
    coord.release(1, workerId);
    expect(coord.refCount(1)).toBe(0);
  });

  test("releases all refs when a worker closes", () => {
    const mem = new SharedMemory();
    const coord = new RefCountCoordinator(mem);
    const worker = { onclose: null as (() => void) | null };
    const workerId = coord.registerWorker(worker);
    coord.acquire(1, workerId);
    coord.acquire(2, workerId);
    expect(coord.refCount(1)).toBe(1);
    expect(coord.refCount(2)).toBe(1);
    // Simulate the worker closing.
    worker.onclose!();
    expect(coord.refCount(1)).toBe(0);
    expect(coord.refCount(2)).toBe(0);
  });

  test("drains events from the ring buffer", () => {
    const mem = new SharedMemory();
    const buf = new RefCountBuffer();
    const coord = new RefCountCoordinator(mem, buf);
    const workerId = coord.registerWorker({});
    buf.pushEvent(workerId, 1, 10);
    coord.drainEvents();
    expect(coord.refCount(10)).toBe(1);
  });
});

describe("RefCountTracker", () => {
  test("queues an acquire event on track", () => {
    const buf = new RefCountBuffer();
    const tracker = new RefCountTracker(buf, 0);
    const obj = { name: "x" };
    tracker.track(obj, 99);
    // track() queues an acquire event; the coordinator drains it into the
    // global refcount table.
    expect(buf.popEvent()).toEqual({ workerId: 0, op: 1, objectId: 99 });
  });
});

describe("Defragmentation", () => {
  test("reclaims dead space while preserving all values", () => {
    const mem = new SharedMemory({ initialSize: 1024, maxByteLength: 1 << 20 });
    const a = Shared("a", { name: "alpha", tags: ["x", "y", "z"] }, { memory: mem });
    const b = Shared("b", { name: "beta", nums: [1, 2, 3, 4, 5] }, { memory: mem });
    const c = Shared("c", "gamma", { memory: mem });

    // Overwrite to create dead space (abandoned array blocks and strings).
    a.write({ name: "alpha2", tags: ["x", "y", "z"] });
    b.write({ name: "beta2", nums: [1, 2, 3, 4, 5] });
    c.write("gamma2");

    const arrBefore = mem.arrayTable.byteLength;
    const strBefore = mem.stringTable.byteLength;

    mem.withLock(() => mem.defragment());

    expect(mem.arrayTable.byteLength).toBeLessThan(arrBefore);
    expect(mem.stringTable.byteLength).toBeLessThan(strBefore);

    // All values must still be correct after defragmentation.
    const ra = a.read();
    const rb = b.read();
    const rc = c.read();
    expect(ra.name).toBe("alpha2");
    expect(ra.tags).toEqual(["x", "y", "z"]);
    expect(rb.name).toBe("beta2");
    expect(rb.nums).toEqual([1, 2, 3, 4, 5]);
    expect(rc).toBe("gamma2");
  });

  test("preserves arrays that grew via push", () => {
    const mem = new SharedMemory({ initialSize: 1024, maxByteLength: 1 << 20 });
    const arr = Shared("arr", [1, 2, 3], { memory: mem });
    for (let i = 0; i < 20; i++) arr.push(i);

    mem.withLock(() => mem.defragment());

    const ra = arr.read();
    expect(ra.length).toBe(23);
    for (let i = 0; i < 20; i++) expect(ra[i + 3]).toBe(i);
  });

  test("preserves bigints, strings, numbers, and booleans", () => {
    const mem = new SharedMemory({ initialSize: 1024, maxByteLength: 1 << 20 });
    const big = Shared(
      "big",
      { huge: 2n ** 100n, small: 5n, name: "hello", n: 3.14 },
      { memory: mem },
    );
    const arr = Shared("arr", [2n ** 200n, "world", 42, true], { memory: mem });

    big.write({ huge: 2n ** 101n, small: 6n, name: "hello2", n: 2.71 });
    arr.write([2n ** 201n, "world2", 43, false]);

    mem.withLock(() => mem.defragment());

    const rb = big.read();
    const ra = arr.read();
    expect(rb.huge).toBe(2n ** 101n);
    expect(rb.small).toBe(6n);
    expect(rb.name).toBe("hello2");
    expect(rb.n).toBe(2.71);
    expect(ra[0]).toBe(2n ** 201n);
    expect(ra[1]).toBe("world2");
    expect(ra[2]).toBe(43);
    expect(ra[3]).toBe(false);
  });

  test("bumps the layout version so caches are invalidated", () => {
    const mem = new SharedMemory({ initialSize: 1024, maxByteLength: 1 << 20 });
    const before = mem.getLayoutVersion();
    mem.withLock(() => mem.defragment());
    expect(mem.getLayoutVersion()).toBeGreaterThan(before);
  });
});

describe("RefCount across workers", () => {
  test("a worker's refs are released when it closes", async () => {
    const mem = new SharedMemory({ maxByteLength: 64 * 1024 * 1024 });
    const coord = new RefCountCoordinator(mem);
    const user = Shared("rc-worker-1", { name: "Alice", age: 30 }, { memory: mem });

    const workerCode = `
      import { SharedMemory, Mutex, Shared, RefCountTracker, RefCountBuffer } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers, lockBuf, refBuf, key } = e.data;
        const mem = new SharedMemory({ lock: new Mutex(lockBuf), buffers });
        const refBuf2 = new RefCountBuffer(refBuf);
        const workerId = refBuf2.allocateWorkerId();
        const tracker = new RefCountTracker(refBuf2, workerId);
        const user = Shared(key, { name: "Alice", age: 30 }, { memory: mem, refCount: tracker });
        const copy = user.read(); // acquires a ref
        self.postMessage({ name: copy.name, age: copy.age });
        self.close(); // triggers the coordinator's close listener
      };
    `;

    const worker = new Worker(
      new URL("data:text/javascript," + encodeURIComponent(workerCode), import.meta.url),
      { type: "module" },
    );
    // Auto-register the worker; its close handler releases its refs.
    const stop = coord.autoRegister();

    const read = await new Promise<{ name: string; age: number }>((resolve) => {
      worker.onmessage = (e) => resolve(e.data as { name: string; age: number });
      worker.postMessage({
        key: "rc-worker-1",
        lockBuf: mem.lock.buffer,
        refBuf: coord.sab,
        buffers: {
          indexTable: mem.indexTable.buffer,
          dataTable: mem.dataTable.buffer,
          stringTable: mem.stringTable.buffer,
          arrayTable: mem.arrayTable.buffer,
          versionTable: mem.versionTable.buffer,
          layoutVersion: mem.layoutVersion.buffer,
        },
      });
    });

    expect(read.name).toBe("Alice");
    expect(read.age).toBe(30);

    // The worker acquired a ref; drain the event and verify it is tracked.
    coord.drainEvents();
    const objectId = mem.getObjectId(mem.lookup("rc-worker-1")!);
    expect(coord.refCount(objectId)).toBe(1);

    // The worker calls self.close(); the coordinator's close listener
    // releases its refs.
    await new Promise<void>((resolve) => {
      worker.addEventListener("close", () => resolve());
    });
    expect(coord.refCount(objectId)).toBe(0);
    stop();
  });

  test("auto maintenance drains events and defragments on demand", async () => {
    const mem = new SharedMemory();
    const buf = new RefCountBuffer();
    const coord = new RefCountCoordinator(mem, buf);
    const workerId = coord.registerWorker({});

    // Push an acquire event directly into the ring buffer (as a worker would).
    const objectId = 1;
    buf.pushEvent(workerId, 1, objectId);
    expect(coord.refCount(objectId)).toBe(0);

    const stop = coord.startAutoMaintenance(5);
    // Wait for the timer to drain the event.
    await new Promise((r) => setTimeout(r, 30));
    expect(coord.refCount(objectId)).toBe(1);

    // Push a release event; it should be drained too.
    buf.pushEvent(workerId, 0, objectId);
    await new Promise((r) => setTimeout(r, 30));
    expect(coord.refCount(objectId)).toBe(0);

    stop();
  });
});
