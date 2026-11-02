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
    const coord = new RefCountCoordinator(mem, undefined, {
      autoMaintenance: false,
    });
    const workerId = coord.registerWorker({});
    coord.acquire(1, workerId);
    expect(coord.refCount(1)).toBe(1);
    coord.release(1, workerId);
    expect(coord.refCount(1)).toBe(0);
  });

  test("releases all refs when a worker closes", () => {
    const mem = new SharedMemory();
    const coord = new RefCountCoordinator(mem, undefined, {
      autoMaintenance: false,
    });
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
    const coord = new RefCountCoordinator(mem, buf, { autoMaintenance: false });
    const workerId = coord.registerWorker({});
    buf.pushEvent(workerId, 1, 10);
    coord.drainEvents();

    expect(coord.refCount(10)).toBe(1);
  });

  test("calls onDefragment with the new chunk lists after defragmentation", async () => {
    const mem = new SharedMemory({
      initialSize: 1024,
      maxByteLength: 32 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
    });
    let defragResult: {
      indexTable: SharedArrayBuffer[];
      dataTable: SharedArrayBuffer[];
      stringTable: SharedArrayBuffer[];
      arrayTable: SharedArrayBuffer[];
    } | null = null;
    const coord = new RefCountCoordinator(mem, undefined, {
      autoMaintenance: true,
      maintenanceInterval: 5,
      defragThreshold: 0.5,
      onDefragment: (buffers) => {
        defragResult = buffers;
      },
    });

    // Grow the ArrayTable across several chunks, then overwrite to create
    // dead space so defragmentation replaces inactive chunks.
    const keys: string[] = [];
    for (let i = 0; i < 300; i++) {
      const key = `gc-${i}`;
      keys.push(key);
      Shared(
        key,
        Array.from({ length: 5000 }, (_, j) => j),
        { memory: mem },
      );
    }
    for (let i = 0; i < 300; i++) {
      Shared(keys[i]!, [i], { memory: mem }).write([i]);
    }

    // Wait for the maintenance timer to run a defragmentation pass and invoke
    // the onDefragment callback with the new chunk lists.
    const deadline = Date.now() + 2000;
    while (defragResult === null && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(defragResult).not.toBeNull();
    expect(defragResult!.arrayTable.some((sab) => sab.byteLength === 4)).toBe(
      true,
    );
    coord.stopAutoMaintenance();
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
    const a = Shared(
      "a",
      { name: "alpha", tags: ["x", "y", "z"] },
      { memory: mem },
    );
    const b = Shared(
      "b",
      { name: "beta", nums: [1, 2, 3, 4, 5] },
      { memory: mem },
    );
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

  test("releases unused chunks after defragmentation", () => {
    // Use the minimum chunk size so a few writes span multiple chunks.
    const mem = new SharedMemory({
      initialSize: 1024,
      maxByteLength: 32 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
    });

    // Write enough arrays to grow the ArrayTable across several chunks.
    const keys: string[] = [];
    for (let i = 0; i < 300; i++) {
      const key = `k${i}`;
      keys.push(key);
      Shared(
        key,
        Array.from({ length: 5000 }, (_, j) => j),
        { memory: mem },
      );
    }
    const chunksBefore = mem.arrayTable.activeChunkCount;
    expect(chunksBefore).toBeGreaterThan(1);

    // Overwrite every array with a tiny one, creating dead space.
    for (let i = 0; i < 300; i++) {
      Shared(keys[i]!, [i], { memory: mem }).write([i]);
    }

    mem.withLock(() => mem.defragment());

    // The compacted ArrayTable fits in fewer chunks; the excess chunks are
    // marked inactive (their storage is released by the GC).
    const chunksAfter = mem.arrayTable.activeChunkCount;
    expect(chunksAfter).toBeLessThan(chunksBefore);

    // All values are still correct.
    for (let i = 0; i < 100; i++) {
      expect(Shared<number[]>(keys[i]!, [], { memory: mem }).read()[0]).toBe(i);
    }
  });

  test("replaces inactive chunks with fresh 4-byte buffers after defragmentation", () => {
    const mem = new SharedMemory({
      initialSize: 1024,
      maxByteLength: 1 << 20,
      chunkSize: 4096,
    });

    // Grow the ArrayTable across several chunks.
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const key = `k${i}`;
      keys.push(key);
      Shared(
        key,
        Array.from({ length: 50 }, (_, j) => j),
        { memory: mem },
      );
    }
    const totalChunks = mem.arrayTable.buffers.length;
    expect(totalChunks).toBeGreaterThan(1);

    // Overwrite every array with a tiny one, creating dead space.
    for (let i = 0; i < 100; i++) {
      Shared(keys[i]!, [i], { memory: mem }).write([i]);
    }

    const result = mem.withLock(() => mem.defragment());

    // The returned chunk lists must have the same length (chunks are
    // pre-allocated), but the inactive chunks are now fresh 4-byte buffers.
    expect(result.arrayTable.length).toBe(totalChunks);
    const inactiveCount = result.arrayTable.filter(
      (sab) => sab.byteLength === 4,
    ).length;
    expect(inactiveCount).toBeGreaterThan(0);
    // The active chunks keep their full size.
    const activeCount = result.arrayTable.filter(
      (sab) => sab.byteLength === mem.arrayTable.chunkSize,
    ).length;
    expect(activeCount).toBe(mem.arrayTable.activeChunkCount);

    // All values are still correct.
    for (let i = 0; i < 100; i++) {
      expect(Shared<number[]>(keys[i]!, [], { memory: mem }).read()[0]).toBe(i);
    }
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

  test("preserves per-key versions across defragmentation", () => {
    const mem = new SharedMemory({ initialSize: 1024, maxByteLength: 1 << 20 });
    const a = Shared("ver-a", { name: "alpha" }, { memory: mem });
    const b = Shared("ver-b", { name: "beta" }, { memory: mem });

    // Bump each key's version a distinct number of times.
    a.write({ name: "alpha2" });
    a.write({ name: "alpha3" });
    b.write({ name: "beta2" });

    const indexA = mem.lookupIndex("ver-a")!;
    const indexB = mem.lookupIndex("ver-b")!;
    const versionA = mem.getVersion(indexA);
    const versionB = mem.getVersion(indexB);
    expect(versionA).toBeGreaterThan(0);
    expect(versionB).toBeGreaterThan(0);

    // Defragment (creates dead space from the overwrites) and verify the
    // versions are unchanged — the version lives in the index entry, which is
    // rewritten in place during defragmentation.
    mem.withLock(() => mem.defragment());

    expect(mem.getVersion(mem.lookupIndex("ver-a")!)).toBe(versionA);
    expect(mem.getVersion(mem.lookupIndex("ver-b")!)).toBe(versionB);
  });
});

describe("RefCount across workers", () => {
  test("a worker's refs are released when it closes", async () => {
    const mem = new SharedMemory({ maxByteLength: 64 * 1024 * 1024 });
    const coord = new RefCountCoordinator(mem, undefined, {
      autoMaintenance: false,
    });
    const user = Shared(
      "rc-worker-1",
      { name: "Alice", age: 30 },
      { memory: mem },
    );

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
      new URL(
        "data:text/javascript," + encodeURIComponent(workerCode),
        import.meta.url,
      ),
      { type: "module" },
    );
    // Auto-register the worker; its close handler releases its refs.
    const stop = coord.autoRegister();

    const read = await new Promise<{ name: string; age: number }>((resolve) => {
      worker.onmessage = (e) =>
        resolve(e.data as { name: string; age: number });
      worker.postMessage({
        key: "rc-worker-1",
        lockBuf: mem.lock.buffer,
        refBuf: coord.sab,
        buffers: {
          indexTable: mem.indexTable.buffers[0],
          dataTable: mem.dataTable.buffers[0],
          stringTable: mem.stringTable.buffers[0],
          arrayTable: mem.arrayTable.buffers[0],
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
    // autoMaintenance starts automatically in the constructor.
    const coord = new RefCountCoordinator(mem, buf, { maintenanceInterval: 5 });
    const workerId = coord.registerWorker({});

    // Push an acquire event directly into the ring buffer (as a worker would).
    const objectId = 1;
    buf.pushEvent(workerId, 1, objectId);
    expect(coord.refCount(objectId)).toBe(0);

    // Wait for the automatic timer to drain the event.
    await new Promise((r) => setTimeout(r, 30));
    expect(coord.refCount(objectId)).toBe(1);

    // Push a release event; it should be drained too.
    buf.pushEvent(workerId, 0, objectId);
    await new Promise((r) => setTimeout(r, 30));
    expect(coord.refCount(objectId)).toBe(0);

    coord.stopAutoMaintenance();
  });
});

describe(">4 GiB shared memory", () => {
  test("the ArrayTable can exceed the 4 GiB single-SAB limit via chunks", () => {
    // A single SharedArrayBuffer is capped at 4 GiB. With chunking, a buffer
    // can grow past that by spanning multiple chunks. Use a 1 GiB chunk size
    // so only a handful of chunks are needed to cross 4 GiB.
    const mem = new SharedMemory({
      maxByteLength: 8 * 1024 * 1024 * 1024, // 8 GiB
      chunkSize: 1024 * 1024 * 1024, // 1 GiB per chunk
    });

    // Grow the ArrayTable past the 4 GiB single-SAB limit.
    const over4GiB = 4 * 1024 * 1024 * 1024 + 1024;
    mem.arrayTable.ensureCapacity(over4GiB);

    // The capacity now exceeds 4 GiB, backed by multiple chunks.
    expect(mem.arrayTable.capacity).toBeGreaterThan(4 * 1024 * 1024 * 1024);
    expect(mem.arrayTable.buffers.length).toBeGreaterThan(1);

    // Every chunk is its own SharedArrayBuffer, each within the 4 GiB limit.
    for (const sab of mem.arrayTable.buffers) {
      expect(sab.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024 * 1024);
    }
  });

  test("offsets at or above 2 GiB resolve to the correct chunk", () => {
    // A signed 32-bit right shift (`offset >> chunkShift`) turns offsets
    // >= 2 GiB negative, so the chunk index must use an unsigned shift.
    const mem = new SharedMemory({
      maxByteLength: 8 * 1024 * 1024 * 1024, // 8 GiB
      chunkSize: 1024 * 1024 * 1024, // 1 GiB per chunk
    });

    const offset = 2 * 1024 * 1024 * 1024 + 1234; // just past 2 GiB
    mem.arrayTable.ensureCapacity(offset + 4);
    mem.arrayTable.setInt32(offset, 123456789);
    expect(mem.arrayTable.getInt32(offset)).toBe(123456789);
  });
});
