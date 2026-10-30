import { describe, expect, test } from "bun:test";
import { Shared } from "../src/index.ts";

describe("Shared", () => {
  test("creates a shared value from an initial value", () => {
    const user = Shared("user-1", { name: "Alice", age: 30 });
    expect(user.read()).toEqual({ name: "Alice", age: 30 });
  });

  test("returns the same wrapper for the same key", () => {
    const a = Shared("user-2", { name: "Bob" });
    const b = Shared("user-2", { name: "Ignored" });
    expect(a).toBe(b);
    expect(a.read()).toEqual({ name: "Bob" });
  });

  test("writes and reads back a value", () => {
    const counter = Shared("counter-1", 0);
    counter.write(42);
    expect(counter.read()).toBe(42);
  });

  test("supports strings", () => {
    const s = Shared("str-1", "hello");
    expect(s.read()).toBe("hello");
    s.write("world");
    expect(s.read()).toBe("world");
  });

  test("supports booleans and bigint", () => {
    const b = Shared("bool-1", true);
    expect(b.read()).toBe(true);

    const bi = Shared("big-1", 123n);
    expect(bi.read()).toBe(123n);
  });

  test("supports arrays of primitives", () => {
    const arr = Shared("arr-1", [1, 2, 3]);
    expect(arr.read()).toEqual([1, 2, 3]);
    arr.write([4, 5]);
    expect(arr.read()).toEqual([4, 5]);
  });

  test("supports mixed arrays", () => {
    const mixed = Shared("mixed-1", [1, "a", true, 2n]);
    expect(mixed.read()).toEqual([1, "a", true, 2n]);
  });

  test("supports objects with primitive and array values", () => {
    const data = Shared("data-1", {
      count: 3,
      tags: ["x", "y"],
      active: true,
    });
    expect(data.read()).toEqual({
      count: 3,
      tags: ["x", "y"],
      active: true,
    });
  });

  test("allows changing values of existing object properties", () => {
    const user = Shared("user-3", { name: "Alice", age: 30 });
    user.write({ name: "Alice", age: 31 });
    expect(user.read()).toEqual({ name: "Alice", age: 31 });
  });

  test("rejects adding a property to a fixed-shape object", () => {
    const user = Shared("user-4", { name: "Alice", age: 30 });
    expect(() =>
      user.write({ name: "Alice", age: 30, email: "a@b.c" } as never),
    ).toThrow(TypeError);
  });

  test("rejects removing a property from a fixed-shape object", () => {
    const user = Shared("user-5", { name: "Alice", age: 30 });
    expect(() => user.write({ name: "Alice" } as never)).toThrow(TypeError);
  });

  test("rejects replacing an object with a non-object", () => {
    const user = Shared("user-6", { name: "Alice" });
    expect(() => user.write(42 as never)).toThrow(TypeError);
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
    expect(user.read()).toEqual({ name: "Carol", age: 25 });
  });

  test("creates a shared value from an async loader", async () => {
    const user = await Shared("user-8", async () => {
      await Bun.sleep(1);
      return { name: "Dave", age: 40 };
    });
    expect(user.read()).toEqual({ name: "Dave", age: 40 });
  });

  test("update applies a transform atomically", () => {
    const counter = Shared("counter-2", 0);
    const result = counter.update((n) => n + 1);
    expect(result).toBe(1);
    expect(counter.read()).toBe(1);
  });

  test("update enforces fixed shape", () => {
    const user = Shared("user-9", { name: "Alice", age: 30 });
    expect(() =>
      user.update((u) => ({ ...u, email: "a@b.c" }) as never),
    ).toThrow(TypeError);
  });

  test("throws when a value exceeds the slot size", () => {
    const small = Shared("small-1", "x", { size: 8 });
    expect(() => small.write("a".repeat(100))).toThrow(RangeError);
  });
});
