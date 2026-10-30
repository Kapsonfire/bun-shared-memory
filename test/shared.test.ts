import { describe, expect, test } from "bun:test";
import { Shared } from "../src/index.ts";

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
});
