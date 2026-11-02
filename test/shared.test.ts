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

  test("rejects nested objects", () => {
    expect(() => Shared("bad-1", { nested: { a: 1 } })).toThrow(TypeError);
  });

  test("rejects null and undefined values", () => {
    expect(() => Shared("bad-2", null as never)).toThrow(TypeError);
    expect(() => Shared("bad-3", undefined as never)).toThrow(TypeError);
  });

  test("rejects nested arrays", () => {
    expect(() => Shared("bad-4", [[1, 2]])).toThrow(TypeError);
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
    // The StringTable must not grow on a cache hit.
    expect(mem.stringTable.byteLength).toBe(r1.length);
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

describe("SharedMemory total memory budget", () => {
  test("maxTotalBytes caps the sum of all buffers, not each buffer", () => {
    // A small total budget. Each buffer's own maxByteLength is capped at
    // maxTotalBytes = 8192, but the *sum* of all buffers is capped at 8192.
    // The 4 initial buffers (1024 each = 4096) fit within the budget.
    const mem = new SharedMemory({ maxTotalBytes: 8192, chunkSize: 1024 });

    // Writing enough distinct strings must eventually exceed the total budget
    // even though no single buffer would exceed its own maxByteLength.
    let threw = false;
    try {
      for (let i = 0; i < 100_000; i++) {
        mem.storeString(`string-number-${i}-with-some-length`);
      }
    } catch (e) {
      threw = e instanceof RangeError;
    }
    expect(threw).toBe(true);

    // The total physical size never exceeded the budget.
    const total =
      mem.indexTable.buffers[0]!.byteLength +
      mem.dataTable.buffers[0]!.byteLength +
      mem.stringTable.buffers[0]!.byteLength +
      mem.arrayTable.buffers[0]!.byteLength;
    expect(total).toBeLessThanOrEqual(8192);
  });

  test("maxTotalBytes smaller than the initial buffers throws", () => {
    // 4 initial buffers of 1024 bytes = 4096, which exceeds a 4096 budget
    // (the budget check is strict: total must stay within the budget).
    expect(
      () => new SharedMemory({ maxTotalBytes: 4095, chunkSize: 1024 }),
    ).toThrow(RangeError);
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
