import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

describe("whole-object writes (write / update) use the cached layout", () => {
  const LONG = "a string that is longer than eleven bytes";

  test("write() replaces every property, whatever its type", () => {
    const mem = new SharedMemory();
    const rec = Shared(
      "ow-all",
      {
        n: 1,
        s: "x",
        big: "y".repeat(30),
        b: true,
        i: 5n,
        list: [1, 2, 3],
        nested: { a: 1 },
        nothing: null as null | number,
      },
      { memory: mem },
    );
    rec.write({
      n: 2.5,
      s: LONG,
      big: "z",
      b: false,
      i: -7n,
      list: [9, 8],
      nested: { a: 2 },
      nothing: 3,
    });
    expect(rec.read()).toEqual({
      n: 2.5,
      s: LONG,
      big: "z",
      b: false,
      i: -7n,
      list: [9, 8],
      nested: { a: 2 },
      nothing: 3,
    });
  });

  test("a write with a missing property is rejected and leaves the object untouched", () => {
    const mem = new SharedMemory();
    const rec = Shared("ow-missing", { a: 1, b: "two" }, { memory: mem });
    expect(() => rec.write({ a: 10 } as never)).toThrow(TypeError);
    expect(rec.read()).toEqual({ a: 1, b: "two" });
  });

  test("a write with an extra property is rejected and leaves the object untouched", () => {
    const mem = new SharedMemory();
    const rec = Shared("ow-extra", { a: 1, b: "two" }, { memory: mem });
    expect(() => rec.write({ a: 10, b: "x", c: 3 } as never)).toThrow(
      TypeError,
    );
    expect(rec.read()).toEqual({ a: 1, b: "two" });
  });

  test("update() is atomic read-modify-write and keeps the shape", () => {
    const mem = new SharedMemory();
    const counter = Shared("ow-update", { n: 0, label: "c" }, { memory: mem });
    for (let i = 0; i < 100; i++) {
      counter.update((c) => ({ n: c.n + 1, label: c.label }));
    }
    expect(counter.read()).toEqual({ n: 100, label: "c" });
    expect(() =>
      counter.update(() => ({ n: 1, label: "c", extra: true }) as never),
    ).toThrow(TypeError);
    expect(counter.read()).toEqual({ n: 100, label: "c" });
  });

  test("reads after writes see every property (name-free decode)", () => {
    const mem = new SharedMemory();
    const rec = Shared(
      "ow-decode",
      { id: 1, name: "alice", active: true, tags: ["a", "b"], note: LONG },
      { memory: mem },
    );
    rec.read();
    for (let i = 0; i < 5; i++) {
      rec.id = i;
      expect(rec.read()).toEqual({
        id: i,
        name: "alice",
        active: true,
        tags: ["a", "b"],
        note: LONG,
      });
    }
  });
});
