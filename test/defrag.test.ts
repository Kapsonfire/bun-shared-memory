import { describe, expect, test } from "bun:test";
import { MaintenanceCoordinator, Shared, SharedMemory } from "../src/index.ts";

describe("MaintenanceCoordinator", () => {
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
    const coord = new MaintenanceCoordinator(mem, {
      autoMaintenance: true,
      maintenanceInterval: 5,
      defragThreshold: 0.2,
      onDefragment: (buffers) => {
        defragResult = buffers;
      },
    });

    // Grow the ArrayTable across several chunks, then overwrite with larger
    // arrays. Writes are lock-free bump allocations, so each overwrite leaves
    // the old block as dead space and the used length grows monotonically.
    // Once the used length exceeds `defragThreshold` of the buffer's capacity,
    // the automatic maintenance loop triggers a defragmentation pass.
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const key = `gc-${i}`;
      keys.push(key);
      Shared(
        key,
        Array.from({ length: 5000 }, (_, j) => j),
        { memory: mem },
      );
    }
    for (let i = 0; i < 100; i++) {
      Shared(
        keys[i]!,
        Array.from({ length: 10000 }, (_, j) => j),
        {
          memory: mem,
        },
      ).write(Array.from({ length: 10000 }, (_, j) => j));
    }

    // Wait for the automatic maintenance loop to run a defragmentation pass.
    const deadline = Date.now() + 2000;
    while (defragResult === null && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(defragResult).not.toBeNull();
    expect(defragResult!.arrayTable.length).toBeGreaterThan(0);
    coord.stopAutoMaintenance();
  });

  test("registerWorker/unregisterWorker are idempotent and tolerate unknown workers", () => {
    const mem = new SharedMemory();
    const coord = new MaintenanceCoordinator(mem, { autoMaintenance: false });
    const worker = { onclose: null as (() => void) | null };
    const id = coord.registerWorker(worker);
    expect(typeof id).toBe("number");
    // The close handler is installed; invoking it twice must be harmless.
    worker.onclose?.();
    worker.onclose?.();
    coord.unregisterWorker(worker);
    coord.unregisterWorker(12345);
  });

  test("auto maintenance defragments only when a table is nearly full", async () => {
    const mem = new SharedMemory({
      initialSize: 1024,
      maxByteLength: 8 * 1024 * 1024,
      chunkSize: 1024 * 1024,
    });
    let passes = 0;
    const coord = new MaintenanceCoordinator(mem, {
      maintenanceInterval: 5,
      onDefragment: () => {
        passes++;
      },
    });
    Shared("idle", { n: 1 }, { memory: mem });
    await Bun.sleep(60);
    expect(passes).toBe(0);
    coord.stopAutoMaintenance();
  });
});

describe("Defragmentation", () => {
  test("remaps nested object references when the compaction moves blocks", () => {
    // A whole write stores new nested object blocks behind the old ones; the
    // compaction then moves the root block onto space that held something
    // else. The remap pass used to read each block's type at its old offset
    // (where another block now lies), so the root was not recognised as an
    // object and `p` kept pointing at its old, now unused offset.
    const long = "a long string value here";
    const writes = [
      { p: { q: null, r: { s: long } }, n: long },
      { p: { q: 1, r: { s: long } }, n: long },
      { p: { q: null, r: { s: "y" } }, n: "z" },
    ];
    for (const next of writes) {
      for (const defragFirst of [true, false]) {
        const mem = new SharedMemory({
          initialSize: 4096,
          maxByteLength: 1 << 24,
        });
        const o = Shared(
          "defrag-nested",
          { p: { q: 1 as unknown, r: { s: "x" as unknown } }, n: 0 as unknown },
          { memory: mem },
        );
        Shared("defrag-filler", { a: [1, 2, 3], b: "filler" }, { memory: mem });
        if (defragFirst) mem.withLock(() => mem.defragment());
        o.write(structuredClone(next));
        mem.withLock(() => mem.defragment());
        const where = `${JSON.stringify(next)}, defrag first: ${defragFirst}`;
        expect(o.p.r.s, where).toBe(next.p.r.s);
        o.n = 5; // bump the version so the next read decodes from memory
        expect(o.read(), where).toEqual({ ...next, n: 5 });
        mem.dispose();
      }
    }
  });

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

    mem.withLock(() => mem.defragment());

    // The ArrayTable reclaims dead space (abandoned array/string-value blocks
    // that could not be reused because their sizes differed). The StringTable
    // is append-only and holds interned property names, which are never freed,
    // so it does not shrink here.
    expect(mem.arrayTable.byteLength).toBeLessThan(arrBefore);

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

  test("defragments nested objects (plain + live shared refs)", () => {
    const mem = new SharedMemory({ initialSize: 1024, maxByteLength: 1 << 20 });
    const inner = Shared(
      "inner",
      { label: "deep", tags: ["a", "b"] },
      { memory: mem },
    );

    type OuterShape = {
      profile: { name: string; meta: { level: number } };
      handler: { label: string; tags: string[] };
    };
    // `profile` is a plain nested object; `handler` is a live shared ref that
    // is wired to `inner` after creation. Both must survive a defrag.
    const outer = Shared<OuterShape>(
      "outer",
      {
        profile: { name: "alpha", meta: { level: 1 } },
        handler: { label: "deep", tags: ["a", "b"] },
      },
      { memory: mem },
    );
    const mutable = outer as unknown as OuterShape & {
      handler: typeof inner;
    };
    mutable.handler = inner;

    // Overwrite to create dead space and force object-block rewiring.
    outer.write({
      profile: { name: "alpha2", meta: { level: 2 } },
      handler: inner,
    });

    mem.withLock(() => mem.defragment());

    const ro = outer.read();
    expect(ro.profile).toEqual({ name: "alpha2", meta: { level: 2 } });
    // Plain nested object still linked, and mutating it in place stays in sync.
    mutable.profile.meta.level = 9;
    expect(outer.read().profile.meta.level).toBe(9);
    // Live nested refs stay linked after defrag.
    expect(mutable.handler).toBe(inner);
    inner.write({ label: "deep3", tags: ["x"] });
    expect(mutable.handler.label).toBe("deep3");
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
