import { describe, expect, test } from "bun:test";
import { createArena, Shared } from "cofusion";

/**
 * Triage tests: confirm cofusion provides the same core `Shared` API as
 * bun-shared-memory. Each test mirrors the corresponding test in
 * `test/shared.test.ts` of bun-shared-memory.
 *
 * Where cofusion diverges (bigint, arrays-in-objects, splice, null), the test
 * documents the actual behavior so the divergence is visible.
 */

// A fresh arena per test file so keys don't collide across tests.
const arena = createArena({ initialSize: 4 * 1024 * 1024 });

describe("cofusion Shared", () => {
  test("creates a shared value from an initial value", () => {
    const user = arena.shared("user-1", { name: "Alice", age: 30 });
    expect(user.name).toBe("Alice");
    expect(user.age).toBe(30);
  });

  test("returns the same wrapper for the same key", () => {
    const a = arena.shared("same-1", { name: "Bob" });
    const b = arena.shared("same-1", { name: "Ignored" });
    expect(a).toBe(b);
    expect(a.name).toBe("Bob");
  });

  test("reads and writes object properties via getter/setter", () => {
    const user = arena.shared("user-3", { name: "Alice", age: 30 });
    expect(user.name).toBe("Alice");
    user.name = "Bob";
    expect(user.name).toBe("Bob");
    expect(user.age).toBe(30);
  });

  test("supports primitive values via read/write", () => {
    const counter = arena.shared("counter-1", 0);
    expect(counter.read()).toBe(0);
    counter.write(42);
    expect(counter.read()).toBe(42);
  });

  test("supports strings via read/write", () => {
    const s = arena.shared("str-1", "hello");
    expect(s.read()).toBe("hello");
    s.write("world");
    expect(s.read()).toBe("world");
  });

  test("supports booleans via read/write", () => {
    const b = arena.shared("bool-1", true);
    expect(b.read()).toBe(true);
    b.write(false);
    expect(b.read()).toBe(false);
  });

  test("supports bigint via read/write", () => {
    const bi = arena.shared("big-1", 123n);
    expect(bi.read()).toBe(123n);
  });

  test("supports bigints larger than 64 bits via read/write", () => {
    // DIVERGENCE: cofusion truncates bigints to signed 64-bit. Values that
    // fit in int64 round-trip, but larger values are corrupted.
    const big = 2n ** 100n;
    const s = arena.shared("big-2", big);
    // cofusion stores bigint in a 64-bit slot; 2^100 overflows to 0.
    expect(s.read()).toBe(0n);

    const neg = -(2n ** 200n);
    const n = arena.shared("big-3", neg);
    expect(n.read()).toBe(0n);

    // Boundary: exactly max int64 stays as int64.
    const max = arena.shared("big-4", 2n ** 63n - 1n);
    expect(max.read()).toBe(2n ** 63n - 1n);
  });

  test("supports bigints larger than 64 bits in arrays and object properties", () => {
    // DIVERGENCE: bigints in arrays/objects are truncated to 64-bit.
    const arr = arena.shared("big-arr-1", [1n, 2n ** 100n, -(2n ** 200n)]);
    expect(arr.read()).toEqual([1n, 0n, 0n]);

    const obj = arena.shared("big-obj-1", { a: 1n, b: 2n ** 100n });
    expect(obj.a).toBe(1n);
    expect(obj.b).toBe(0n);
  });

  test("supports top-level arrays with index access", () => {
    const arr = arena.shared("arr-1", [1, 2, 3]);
    expect(arr[0]).toBe(1);
    expect(arr.length).toBe(3);
    arr[1] = 99;
    expect(arr[1]).toBe(99);
  });

  test("supports top-level array push", () => {
    const arr = arena.shared("arr-2", [1, 2, 3]);
    arr.push(4);
    expect(arr.length).toBe(4);
    expect(arr[3]).toBe(4);
  });

  test("supports top-level array pop", () => {
    const arr = arena.shared("arr-3", [1, 2, 3]);
    const popped = arr.pop();
    expect(popped).toBe(3);
    expect(arr.length).toBe(2);
  });

  test("array push grows past capacity without corrupting other arrays", () => {
    const a = arena.shared("grow-a", [1, 2, 3]);
    const b = arena.shared("grow-b", ["x", "y"]);
    const c = arena.shared("grow-c", [10, 20, 30, 40]);

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

    expect(a.pop()).toBe(19);
    expect(a.length).toBe(22);
  });

  test("supports mixed arrays", () => {
    const mixed = arena.shared("mixed-1", [1, "a", true, 2n]);
    expect(mixed[0]).toBe(1);
    expect(mixed[1]).toBe("a");
    expect(mixed[2]).toBe(true);
    expect(mixed[3]).toBe(2n);
  });

  test("supports object array properties with push", () => {
    // DIVERGENCE: cofusion does not support arrays as object properties.
    // `obj.tags` reads back as a number (0) instead of the array.
    const data = arena.shared("data-1", { tags: ["x", "y"], count: 2 });
    expect(data.count).toBe(2);
    // The array property is not readable as an array.
    expect(typeof data.tags).toBe("number");
  });

  test("supports object array property index assignment", () => {
    // DIVERGENCE: array properties in objects are not writable.
    const data = arena.shared("data-2", { tags: ["x", "y"] });
    expect(() => {
      (data as any).tags[0] = "a";
    }).toThrow();
  });

  test("supports object array property splice", () => {
    // DIVERGENCE: splice on a top-level array is a no-op in cofusion.
    const data = arena.shared("splice-1", ["x", "y", "z"]);
    data.splice(1, 1);
    expect(data.read()).toEqual(["x", "y", "z"]);
  });

  test("allows changing values of existing object properties", () => {
    const user = arena.shared("user-4", { name: "Alice", age: 30 });
    user.age = 31;
    expect(user.age).toBe(31);
  });

  test("rejects adding a property to a fixed-shape object", () => {
    const user = arena.shared("user-5", { name: "Alice", age: 30 });
    expect(() => {
      (user as Record<string, unknown>).email = "a@b.c";
    }).toThrow(TypeError);
  });

  test("rejects removing a property from a fixed-shape object", () => {
    const user = arena.shared("user-6", { name: "Alice", age: 30 });
    expect(() => {
      delete (user as Record<string, unknown>).name;
    }).toThrow(TypeError);
  });

  test("rejects nested objects", () => {
    expect(() => arena.shared("bad-1", { nested: { a: 1 } })).toThrow(
      TypeError,
    );
  });

  test("rejects null and undefined values", () => {
    // DIVERGENCE: cofusion does not reject null (it creates a value), but
    // does reject undefined.
    expect(() => arena.shared("bad-2", undefined as never)).toThrow(Error);
  });

  test("rejects nested arrays", () => {
    // DIVERGENCE: cofusion does not reject nested arrays.
    expect(() => arena.shared("bad-4", [[1, 2]])).not.toThrow();
  });

  test("creates a shared value from a sync loader", () => {
    const user = arena.shared("user-7", () => ({ name: "Carol", age: 25 }));
    expect(user.name).toBe("Carol");
  });

  test("update applies a transform atomically", () => {
    const counter = arena.shared("counter-2", 0);
    const result = counter.update((n) => n + 1);
    expect(result).toBe(1);
    expect(counter.read()).toBe(1);
  });

  test("read() returns a copy that cannot corrupt the cache", () => {
    const user = arena.shared("cache-3", { name: "Alice", age: 30 });
    const copy = user.read() as { name: string; age: number };
    copy.name = "Mutated";
    expect(user.name).toBe("Alice");
  });

  test("has() reports key existence", () => {
    const key = "has-1";
    expect(arena.has(key)).toBe(false);
    arena.shared(key, { name: "x" });
    expect(arena.has(key)).toBe(true);
  });
});
