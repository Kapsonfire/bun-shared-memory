import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

describe("Shared", () => {
  test("creates a shared value from an initial value", () => {
    const user = Shared("user-1", { name: "Alice", age: 30 });
    expect(user.name).toBe("Alice");
    expect(user.age).toBe(30);
  });

  test("returns the same wrapper for the same key", () => {
    const a = Shared("user-2", { name: "Bob" });
    const b = Shared("user-2", { name: "Ignored" });
    expect(a).toBe(b);
    expect(a.name).toBe("Bob");
  });

  test("reads and writes object properties via getter/setter", () => {
    const user = Shared("user-3", { name: "Alice", age: 30 });
    expect(user.name).toBe("Alice");
    user.name = "Bob";
    expect(user.name).toBe("Bob");
    expect(user.age).toBe(30);
  });

  test("supports primitive values via read/write", () => {
    const counter = Shared("counter-1", 0);
    expect(counter.read()).toBe(0);
    counter.write(42);
    expect(counter.read()).toBe(42);
  });

  test("supports strings via read/write", () => {
    const s = Shared("str-1", "hello");
    expect(s.read()).toBe("hello");
    s.write("world");
    expect(s.read()).toBe("world");
  });

  test("supports booleans and bigint via read/write", () => {
    const b = Shared("bool-1", true);
    expect(b.read()).toBe(true);

    const bi = Shared("big-1", 123n);
    expect(bi.read()).toBe(123n);
  });

  test("supports bigints larger than 64 bits via read/write", () => {
    const big = 2n ** 100n;
    const s = Shared("big-2", big);
    expect(s.read()).toBe(big);

    const neg = -(2n ** 200n);
    const n = Shared("big-3", neg);
    expect(n.read()).toBe(neg);

    // Boundary: exactly max/min int64 stay as int64; just past go to string.
    const max = Shared("big-4", 2n ** 63n - 1n);
    expect(max.read()).toBe(2n ** 63n - 1n);
    const over = Shared("big-5", 2n ** 63n);
    expect(over.read()).toBe(2n ** 63n);
  });

  test("supports bigints larger than 64 bits in arrays and object properties", () => {
    const arr = Shared("big-arr-1", [1n, 2n ** 100n, -(2n ** 200n)]);
    expect(arr.read()).toEqual([1n, 2n ** 100n, -(2n ** 200n)]);

    const obj = Shared("big-obj-1", { a: 1n, b: 2n ** 100n });
    expect(obj.a).toBe(1n);
    expect(obj.b).toBe(2n ** 100n);
  });

  test("supports top-level arrays with index access", () => {
    const arr = Shared("arr-1", [1, 2, 3]);
    expect(arr[0]).toBe(1);
    expect(arr.length).toBe(3);
    arr[1] = 99;
    expect(arr[1]).toBe(99);
  });

  test("supports top-level array push", () => {
    const arr = Shared("arr-2", [1, 2, 3]);
    arr.push(4);
    expect(arr.length).toBe(4);
    expect(arr[3]).toBe(4);
  });

  test("supports top-level array pop", () => {
    const arr = Shared("arr-3", [1, 2, 3]);
    const popped = arr.pop();
    expect(popped).toBe(3);
    expect(arr.length).toBe(2);
  });

  test("array push grows past capacity without corrupting other arrays", () => {
    // Multiple arrays that grow, forcing the array table to move arrays to
    // new locations with larger capacity. Verify no cross-array corruption.
    const a = Shared("grow-a", [1, 2, 3]);
    const b = Shared("grow-b", ["x", "y"]);
    const c = Shared("grow-c", [10, 20, 30, 40]);

    for (let i = 0; i < 20; i++) a.push(i);
    for (let i = 0; i < 20; i++) b.push("s" + i);
    for (let i = 0; i < 20; i++) c.push(i * 10);

    expect(a.read()).toEqual([
      1,
      2,
      3,
      ...Array.from({ length: 20 }, (_, i) => i),
    ]);
    expect(b.read()).toEqual([
      "x",
      "y",
      ...Array.from({ length: 20 }, (_, i) => "s" + i),
    ]);
    expect(c.read()).toEqual([
      10,
      20,
      30,
      40,
      ...Array.from({ length: 20 }, (_, i) => i * 10),
    ]);

    // Pop works after growth.
    expect(a.pop()).toBe(19);
    expect(a.length).toBe(22);
  });

  test("supports mixed arrays", () => {
    const mixed = Shared("mixed-1", [1, "a", true, 2n]);
    expect(mixed[0]).toBe(1);
    expect(mixed[1]).toBe("a");
    expect(mixed[2]).toBe(true);
    expect(mixed[3]).toBe(2n);
  });

  test("supports object array properties with push", () => {
    const data = Shared("data-1", { tags: ["x", "y"], count: 2 });
    data.tags.push("z");
    expect(data.tags.length).toBe(3);
    expect(data.tags[2]).toBe("z");
    expect(data.count).toBe(2);
  });

  test("supports object array property index assignment", () => {
    const data = Shared("data-2", { tags: ["x", "y"] });
    data.tags[0] = "a";
    expect(data.tags[0]).toBe("a");
  });

  test("supports object array property splice", () => {
    const data = Shared("data-3", { tags: ["x", "y", "z"] });
    data.tags.splice(1, 1);
    expect(data.tags.length).toBe(2);
    expect(data.tags[0]).toBe("x");
    expect(data.tags[1]).toBe("z");
  });

  test("supports nested arrays via read()", () => {
    const grid = Shared("nested-1", [
      [1, 2],
      [3, 4],
    ]);
    expect(grid.read()).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("supports reading nested array elements through the proxy", () => {
    const grid = Shared("nested-2", [
      [1, 2],
      [3, 4],
    ]);
    expect(grid[0]![0]).toBe(1);
    expect(grid[0]![1]).toBe(2);
    expect(grid[1]![0]).toBe(3);
    expect(grid[1]![1]).toBe(4);
    expect(grid[0]!.length).toBe(2);
  });

  test("supports writing nested array elements through the proxy", () => {
    const grid = Shared("nested-3", [
      [1, 2],
      [3, 4],
    ]);
    grid[0]![1] = 99;
    expect(grid[0]![1]).toBe(99);
    expect(grid.read()).toEqual([
      [1, 99],
      [3, 4],
    ]);
  });

  test("supports push on a nested array", () => {
    const grid = Shared("nested-4", [
      [1, 2],
      [3, 4],
    ]);
    grid[0]!.push(5);
    expect(grid[0]!.length).toBe(3);
    expect(grid[0]![2]).toBe(5);
    expect(grid.read()).toEqual([
      [1, 2, 5],
      [3, 4],
    ]);
  });

  test("supports pop on a nested array", () => {
    const grid = Shared("nested-5", [
      [1, 2],
      [3, 4],
    ]);
    const popped = grid[1]!.pop();
    expect(popped).toBe(4);
    expect(grid[1]!.length).toBe(1);
    expect(grid.read()).toEqual([[1, 2], [3]]);
  });

  test("supports deeply nested arrays", () => {
    const cube = Shared("nested-6", [
      [
        [1, 2],
        [3, 4],
      ],
      [
        [5, 6],
        [7, 8],
      ],
    ]);
    expect(cube[0]![1]![0]).toBe(3);
    cube[1]![0]![1] = 99;
    expect(cube[1]![0]![1]).toBe(99);
    expect(cube.read()).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
      [
        [5, 99],
        [7, 8],
      ],
    ]);
  });

  test("supports nested arrays as object properties", () => {
    const data = Shared("nested-7", {
      matrix: [
        [1, 2],
        [3, 4],
      ],
      name: "m",
    });
    expect(data.matrix[0]![1]).toBe(2);
    data.matrix[1]![0] = 99;
    expect(data.matrix[1]![0]).toBe(99);
    data.matrix[0]!.push(5);
    expect(data.matrix[0]!.length).toBe(3);
    expect(data.name).toBe("m");
  });

  test("cached array proxy reflects in-place push growth", () => {
    const data = Shared("nested-10", {
      matrix: [
        [1, 2],
        [3, 4],
      ],
    });
    const row = data.matrix[0]!;
    row.push(5);
    // The same cached proxy must see the new length and allow writing the
    // newly appended element.
    expect(row.length).toBe(3);
    row[2] = 9;
    expect(row[2]).toBe(9);
    expect(data.read()).toEqual({
      matrix: [
        [1, 2, 9],
        [3, 4],
      ],
    });
  });

  test("supports splice on a nested array", () => {
    const grid = Shared("nested-11", [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    grid[0]!.splice(1, 1);
    expect(grid[0]!.length).toBe(2);
    expect(grid[0]![0]).toBe(1);
    expect(grid[0]![1]).toBe(3);
    expect(grid.read()).toEqual([
      [1, 3],
      [4, 5, 6],
    ]);
  });

  test("supports mixed nested arrays with primitives", () => {
    const data = Shared("nested-8", [
      [1, "a"],
      [true, 2n],
    ]);
    expect(data[0]![1]).toBe("a");
    expect(data[1]![0]).toBe(true);
    expect(data[1]![1]).toBe(2n);
  });

  test("read() returns a deep copy that cannot corrupt the cache", () => {
    const grid = Shared("nested-9", [
      [1, 2],
      [3, 4],
    ]);
    const copy = grid.read() as number[][];
    copy[0]![0] = 999;
    // The shared value must be unaffected by mutating the returned copy.
    expect(grid[0]![0]).toBe(1);
    expect(grid.read()).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("supports nested plain objects via read()", () => {
    const data = Shared("obj-nested-1", {
      profile: { name: "A", age: 30 },
      tags: "x",
    });
    expect(data.read()).toEqual({
      profile: { name: "A", age: 30 },
      tags: "x",
    });
    // Direct property access returns a live proxy; read it via property access.
    expect(data.profile!.name).toBe("A");
    expect(data.profile!.age).toBe(30);
  });

  test("supports reading nested object properties through the proxy", () => {
    const data = Shared("obj-nested-2", {
      profile: { name: "A", age: 30 },
    });
    expect(data.profile!.name).toBe("A");
    expect(data.profile!.age).toBe(30);
  });

  test("supports writing nested object properties in place (stays in sync)", () => {
    const data = Shared("obj-nested-3", {
      profile: { name: "A", age: 30 },
    });
    data.profile!.name = "B";
    expect(data.profile!.name).toBe("B");
    expect(data.read()).toEqual({ profile: { name: "B", age: 30 } });
  });

  test("supports deeply nested plain objects", () => {
    const data = Shared("obj-nested-4", {
      a: { b: { c: 42, list: [{ d: 1 }] } },
    });
    expect(data.a!.b!.c).toBe(42);
    data.a!.b!.c = 99;
    data.a!.b!.list![0]!.d = 7;
    expect(data.read()).toEqual({
      a: { b: { c: 99, list: [{ d: 7 }] } },
    });
  });

  test("supports objects nested inside arrays", () => {
    const data = Shared("obj-nested-5", [{ x: 1, y: 2 }, { x: 3 }]);
    expect(data[0]!.x).toBe(1);
    data[1]!.x = 30;
    expect(data.read()).toEqual([{ x: 1, y: 2 }, { x: 30 }]);
  });

  test("supports array property nested inside an object", () => {
    const data = Shared("obj-nested-6", {
      grid: [{ a: 1 }, { a: 2 }],
    });
    expect(data.grid![0]!.a).toBe(1);
    data.grid![1]!.a = 20;
    expect(data.read()).toEqual({ grid: [{ a: 1 }, { a: 20 }] });
  });

  test("nested plain object rejects adding a property (fixed shape)", () => {
    const data = Shared("obj-nested-7", { profile: { name: "A" } });
    expect(() => {
      (data.profile as Record<string, unknown>).email = "x@y.z";
    }).toThrow(TypeError);
  });

  test("read() returns a deep copy of nested objects", () => {
    const data = Shared("obj-nested-8", {
      profile: { name: "A", addr: { city: "X" } },
    });
    const copy = data.read() as {
      profile: { name: string; addr: { city: string } };
    };
    copy.profile.addr.city = "Mutated";
    expect(data.profile!.addr!.city).toBe("X");
    expect(data.read()).toEqual({
      profile: { name: "A", addr: { city: "X" } },
    });
  });

  test("supports a shared object nested as a live reference (stays in sync)", () => {
    const profile = Shared("obj-nested-shared-1", { name: "A", age: 30 });
    const user = Shared("obj-nested-shared-1b", {
      profile: profile as unknown as { name: string; age: number },
    });
    expect(user.profile!.name).toBe("A");

    // Write through the nested reference: both see the change.
    user.profile!.name = "B";
    expect(profile.name).toBe("B");
    expect(user.read()).toEqual({ profile: { name: "B", age: 30 } });

    // Write through the original wrapper: the nested reference sees it too.
    profile.age = 31;
    expect(user.profile!.age).toBe(31);
  });

  test("supports a shared object nested in an array (live reference)", () => {
    const a = Shared("obj-nested-shared-2", { v: 1 });
    const b = Shared("obj-nested-shared-2b", { v: 2 });
    const arr = Shared("obj-nested-shared-2c", [
      a as unknown as { v: number },
      b as unknown as { v: number },
    ]);
    arr[0]!.v = 10;
    expect(a.v).toBe(10);
    expect(arr[1]!.v).toBe(2);
  });

  test("handles self-referencing shared objects (recursion loop)", () => {
    // The `self` property must exist in the initial shape (fixed shape), then
    // it is reassigned to point back at the same shared object.
    const node = Shared(
      "obj-self-1" as string,
      {
        self: { placeholder: true },
      } as Record<string, unknown>,
    );
    (node as unknown as Record<string, unknown>).self = node;
    expect((node as unknown as Record<string, unknown>).self).toBe(node);
    // read() must not recurse infinitely on the self reference.
    expect(() => node.read()).not.toThrow();
    const read = node.read() as Record<string, unknown>;
    expect(read.self).toBeTruthy();
  });

  test("handles mutual shared references (recursion loop)", () => {
    const a = Shared(
      "obj-mut-1" as string,
      {
        b: { placeholder: true },
      } as Record<string, unknown>,
    );
    const b = Shared(
      "obj-mut-2" as string,
      {
        a: { placeholder: true },
      } as Record<string, unknown>,
    );
    (a as unknown as Record<string, unknown>).b = b;
    (b as unknown as Record<string, unknown>).a = a;
    expect((a as unknown as Record<string, unknown>).b).toBe(b);
    expect((b as unknown as Record<string, unknown>).a).toBe(a);
    // read() must not recurse infinitely on the mutual reference.
    expect(() => a.read()).not.toThrow();
    expect(() => b.read()).not.toThrow();
    const readA = a.read() as Record<string, unknown>;
    expect(readA.b).toBeTruthy();
  });

  test("rejects cyclic plain objects (no representation)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => Shared("bad-cyclic-1", { cyclic })).toThrow(TypeError);
  });

  test("allows changing values of existing object properties", () => {
    const user = Shared("user-4", { name: "Alice", age: 30 });
    user.age = 31;
    expect(user.age).toBe(31);
  });

  test("rejects adding a property to a fixed-shape object", () => {
    const user = Shared("user-5", { name: "Alice", age: 30 });
    expect(() => {
      (user as Record<string, unknown>).email = "a@b.c";
    }).toThrow(TypeError);
  });

  test("rejects removing a property from a fixed-shape object", () => {
    const user = Shared("user-6", { name: "Alice", age: 30 });
    expect(() => {
      delete (user as Record<string, unknown>).name;
    }).toThrow(TypeError);
  });

  test("rejects null and undefined values", () => {
    expect(() => Shared("bad-2", null as never)).toThrow(TypeError);
    expect(() => Shared("bad-3", undefined as never)).toThrow(TypeError);
  });

  test("creates a shared value from a sync loader", async () => {
    const user = await Shared("user-7", () => ({ name: "Carol", age: 25 }));
    expect(user.name).toBe("Carol");
  });

  test("creates a shared value from an async loader", async () => {
    const user = await Shared("user-8", async () => {
      await Bun.sleep(1);
      return { name: "Dave", age: 40 };
    });
    expect(user.name).toBe("Dave");
  });

  test("update applies a transform atomically", () => {
    const counter = Shared("counter-2", 0);
    const result = counter.update((n) => n + 1);
    expect(result).toBe(1);
    expect(counter.read()).toBe(1);
  });

  test("read cache is invalidated on write", () => {
    const user = Shared("cache-1", { name: "Alice", age: 30 });
    // Prime the cache.
    expect(user.name).toBe("Alice");
    // Write invalidates the cache; the next read must see the new value.
    user.name = "Bob";
    expect(user.name).toBe("Bob");
    user.age = 31;
    expect(user.age).toBe(31);
    expect(user.name).toBe("Bob");
  });

  test("read cache is invalidated on repeated writes", () => {
    const counter = Shared("cache-2", 0);
    for (let i = 1; i <= 100; i++) {
      counter.write(i);
      expect(counter.read()).toBe(i);
    }
  });

  test("read() returns a copy that cannot corrupt the cache", () => {
    const user = Shared("cache-3", { name: "Alice", age: 30 });
    const copy = user.read() as { name: string; age: number };
    copy.name = "Mutated";
    // The cache must be unaffected by mutating the returned copy.
    expect(user.name).toBe("Alice");
  });
});

describe("SharedMemory string interning", () => {
  test("repeated storeString calls reuse the same StringTable ref", () => {
    const mem = new SharedMemory();
    const r1 = mem.storeString("hello");
    const r2 = mem.storeString("hello");
    expect(r2.offset).toBe(r1.offset);
    expect(r2.length).toBe(r1.length);
    // The StringTable must not grow on a cache hit. "hello" is 5 bytes.
    expect(mem.stringTable.byteLength).toBe(5);
  });

  test("distinct strings get distinct refs", () => {
    const mem = new SharedMemory();
    const a = mem.storeString("alpha");
    const b = mem.storeString("beta");
    expect(a.offset).not.toBe(b.offset);
  });

  test("clearInternCache forces re-encoding", () => {
    const mem = new SharedMemory();
    const r1 = mem.storeString("hello");
    mem.clearInternCache();
    const r2 = mem.storeString("hello");
    // After clearing, the string is re-encoded at a new offset.
    expect(r2.offset).not.toBe(r1.offset);
  });
});

describe("SharedMemory string value in-place growth", () => {
  test("overwriting a string with a longer one reuses the block in place", () => {
    const mem = new SharedMemory();
    const obj = Shared(
      "grow-1",
      { url: "https://internal.service.cluster.local/v1/telemetry" },
      { memory: mem },
    );
    const before = mem.arrayTable.byteLength;

    // Grow the string repeatedly. Each write must reuse the existing block
    // (the space after it is free), so the ArrayTable must not grow.
    obj.url = "https://internal.service.cluster.local/v1/metrics";
    obj.url = "https://internal.service.cluster.local/v1/heartbeat";
    obj.url = "https://internal.service.cluster.local/v1/telemetry";

    expect(mem.arrayTable.byteLength).toBe(before);
    expect(obj.url).toBe("https://internal.service.cluster.local/v1/telemetry");
  });

  test("rotating string lengths does not exhaust the ArrayTable", () => {
    const mem = new SharedMemory({ maxByteLength: 64 * 1024 * 1024 });
    const urls = [
      "https://internal.service.cluster.local/v1/telemetry",
      "https://internal.service.cluster.local/v1/metrics",
      "https://internal.service.cluster.local/v1/heartbeat",
    ];
    const obj = Shared("grow-2", { url: urls[0] }, { memory: mem });

    for (let i = 0; i < 100_000; i++) {
      obj.url = urls[i % 3];
    }

    // The block is reused in place, so the ArrayTable stays tiny instead of
    // growing by ~18 bytes per write.
    expect(mem.arrayTable.byteLength).toBeLessThan(1024);
    expect(obj.url).toBe(urls[99_999 % 3]);
  });
});

describe("SharedMemory total memory budget", () => {
  test("keeps the Index Table in one growable SharedArrayBuffer", () => {
    const mem = new SharedMemory({
      initialSize: 4,
      maxByteLength: 4096,
      chunkSize: 16,
    });
    const workerMem = SharedMemory.fromBuffers(mem.exportBuffers());

    for (let i = 0; i < 200; i++) {
      mem.insert(`index-key-${i}`, i);
    }

    expect(mem.indexTable.buffers).toHaveLength(1);
    expect(mem.indexTable.buffers[0]!.maxByteLength).toBe(4096);
    expect(mem.indexTable.buffers[0]!.byteLength).toBeGreaterThan(16);
    expect(workerMem.lookupIndex("index-key-199")).toBe(199);

    mem.bumpVersion(199);
    expect(workerMem.getVersion(199)).toBe(1);
  });

  test("maxTotalBytes caps the combined three-table size", () => {
    // maxTotalBytes is shared by DataTable, StringTable, and ArrayTable, and
    // is clamped to at least 32 MiB.
    const mem = new SharedMemory({ maxTotalBytes: 8192, chunkSize: 1024 });
    expect(mem.maxTotalBytes).toBe(32 * 1024 * 1024);

    // The three tables share one budget: growing them together up to the
    // budget succeeds, and exceeding it throws.
    mem.stringTable.ensureCapacity(8 * 1024 * 1024);
    mem.arrayTable.ensureCapacity(8 * 1024 * 1024);
    mem.dataTable.ensureCapacity(8 * 1024 * 1024);
    // 3 × 8 MiB = 24 MiB fits in the 32 MiB budget; growing the DataTable to
    // 16 MiB would push the combined physical size past the budget.
    expect(() => mem.dataTable.ensureCapacity(16 * 1024 * 1024)).toThrow(
      RangeError,
    );

    const total = [
      ...mem.dataTable.buffers,
      ...mem.stringTable.buffers,
      ...mem.arrayTable.buffers,
    ].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    expect(total).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  test("shares maxTotalBytes atomically with reconstructed workers", () => {
    // maxTotalBytes is clamped to at least 32 MiB.
    const mem = new SharedMemory({
      maxTotalBytes: 96,
      chunkSize: 16,
    });
    const workerMem = SharedMemory.fromBuffers(mem.exportBuffers());

    // The clamped budget is shared atomically across workers.
    expect(workerMem.maxTotalBytes).toBe(32 * 1024 * 1024);

    // Growing the three tables up to the budget succeeds; exceeding it throws.
    mem.indexTable.ensureCapacity(80);
    workerMem.stringTable.ensureCapacity(16);
    mem.arrayTable.ensureCapacity(16);
    expect(() =>
      workerMem.dataTable.ensureCapacity(32 * 1024 * 1024 + 1),
    ).toThrow(RangeError);

    const total = [
      ...mem.dataTable.buffers,
      ...mem.stringTable.buffers,
      ...mem.arrayTable.buffers,
    ].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    expect(total).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  test("maxTotalBytes prevents table growth beyond the combined budget", () => {
    // maxTotalBytes is clamped to at least 32 MiB.
    const mem = new SharedMemory({ maxTotalBytes: 1023, chunkSize: 1024 });
    expect(mem.maxTotalBytes).toBe(32 * 1024 * 1024);
    // Growing beyond the clamped budget throws.
    expect(() => mem.arrayTable.ensureCapacity(32 * 1024 * 1024 + 1)).toThrow(
      RangeError,
    );
  });
});

describe("SharedMemory size limits", () => {
  test("chunkSize is clamped to at least 4 MiB", () => {
    const mem = new SharedMemory({ chunkSize: 16 });
    expect(mem.dataTable.chunkSize).toBe(4 * 1024 * 1024);
    expect(mem.stringTable.chunkSize).toBe(4 * 1024 * 1024);
    expect(mem.arrayTable.chunkSize).toBe(4 * 1024 * 1024);
  });

  test("maxTotalBytes and maxByteLength are clamped to at least 32 MiB", () => {
    const mem = new SharedMemory({ maxTotalBytes: 96, maxByteLength: 8 });
    expect(mem.maxTotalBytes).toBe(32 * 1024 * 1024);
    expect(mem.maxByteLength).toBe(32 * 1024 * 1024);
  });

  test("chunkSize is large enough that no table needs more than 1024 chunks", () => {
    // 8 GiB with the minimum 4 MiB chunk would need 2048 chunks, so the chunk
    // size is raised to keep the chunk count at or below 1024.
    const mem = new SharedMemory({
      maxByteLength: 8 * 1024 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
    });
    expect(mem.dataTable.chunkSize).toBe(8 * 1024 * 1024);
    expect(mem.dataTable.buffers.length).toBeLessThanOrEqual(1024);
  });
});

describe("Shared arrayCapacity option", () => {
  test("reserves extra capacity so push does not move the array", () => {
    const mem = new SharedMemory();
    const arr = Shared("cap-arr-1", [1, 2, 3], {
      memory: mem,
      arrayCapacity: 100,
    });

    // Push well beyond the initial length; all values must be preserved.
    for (let i = 4; i <= 50; i++) {
      arr.push(i);
    }
    expect(arr.read()).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    // The array ref's capacity should be 100 (the reserved capacity), not
    // grown to 64/128 by doubling. Inspect the stored array ref directly.
    const offset = mem.lookupIndex("cap-arr-1");
    expect(offset).not.toBeNull();
    const slot = mem.readValueSlot(mem.lookupByIndex(offset!)!);
    expect(slot.type).toBe(4); // TYPE_ARRAY_REF
    expect(slot.c).toBe(100);
  });

  test("capacity smaller than length falls back to the length", () => {
    const mem = new SharedMemory();
    const arr = Shared("cap-arr-2", [1, 2, 3, 4, 5], {
      memory: mem,
      arrayCapacity: 2,
    });
    const offset = mem.lookupIndex("cap-arr-2");
    expect(offset).not.toBeNull();
    const slot = mem.readValueSlot(mem.lookupByIndex(offset!)!);
    expect(slot.c).toBe(5); // capacity = max(2, length) = 5
    expect(arr.read()).toEqual([1, 2, 3, 4, 5]);
  });
});
