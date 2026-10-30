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

  test("supports nested objects and arrays", () => {
    const data = Shared("data-1", {
      list: [1, 2, 3],
      nested: { a: true, b: null },
    });
    expect(data.read()).toEqual({
      list: [1, 2, 3],
      nested: { a: true, b: null },
    });
  });

  test("supports booleans, bigint, and undefined", () => {
    const b = Shared("bool-1", true);
    expect(b.read()).toBe(true);

    const bi = Shared("big-1", 123n);
    expect(bi.read()).toBe(123n);

    const u = Shared("undef-1", undefined);
    expect(u.read()).toBeUndefined();
  });

  test("creates a shared value from a sync loader", async () => {
    const user = await Shared("user-3", () => ({ name: "Carol", age: 25 }));
    expect(user.read()).toEqual({ name: "Carol", age: 25 });
  });

  test("creates a shared value from an async loader", async () => {
    const user = await Shared("user-4", async () => {
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

  test("throws when a value exceeds the slot size", () => {
    const small = Shared("small-1", "x", { size: 8 });
    expect(() => small.write("a".repeat(100))).toThrow(RangeError);
  });
});
