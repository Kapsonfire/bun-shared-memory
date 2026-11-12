import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

/**
 * `RefTarget.write` has a lock-and-store fast path for a number into a slot whose
 * offset, type and index are cached. These cases are the situations in which it
 * has to step aside or notice that its cached state is outdated.
 */
describe("number write fast path", () => {
  test("every write is visible to the next read", () => {
    const mem = new SharedMemory();
    const n = Shared<number>("fp-seq", 0, { memory: mem });
    for (let i = 1; i <= 1000; i++) {
      n.write(i);
      expect(n.read()).toBe(i);
    }
    n.write(-0.5);
    expect(n.read()).toBe(-0.5);
    n.write(Number.NaN);
    expect(n.read()).toBeNaN();
    mem.dispose();
  });

  test("a write inside withWriteLock / withReadLock of the same ref works", () => {
    const mem = new SharedMemory();
    const n = Shared<number>("fp-lock", 1, { memory: mem });
    n.write(2); // warm the cached offset and type
    n.withWriteLock((self) => {
      self.write(3);
      self.write(4);
    });
    expect(n.read()).toBe(4);
    n.withReadLock((self) => {
      self.write(5);
    });
    expect(n.read()).toBe(5);
    mem.dispose();
  });

  test("a write to another ref inside a write lock works", () => {
    const mem = new SharedMemory();
    const a = Shared<number>("fp-a", 1, { memory: mem });
    const b = Shared<number>("fp-b", 1, { memory: mem });
    a.write(2);
    b.write(2);
    a.withWriteLock((self) => {
      b.write(7);
      self.write(8);
    });
    expect(a.read()).toBe(8);
    expect(b.read()).toBe(7);
    mem.dispose();
  });

  test("a write from inside update() of the same ref works", () => {
    const mem = new SharedMemory();
    const n = Shared<number>("fp-update", 1, { memory: mem });
    n.write(2);
    const result = n.update((cur) => {
      n.write(cur + 10);
      return cur + 100;
    });
    expect(result).toBe(102);
    expect(n.read()).toBe(102);
    mem.dispose();
  });

  test("a write after the layout version changed still lands in the right slot", () => {
    const mem = new SharedMemory();
    const before = Shared<string>("fp-before", "x".repeat(50), { memory: mem });
    const n = Shared<number>("fp-layout", 1, { memory: mem });
    const after = Shared<number>("fp-after", 9, { memory: mem });
    n.write(2); // warm
    before.write("y"); // leaves dead space for the defragmentation to reclaim
    mem.withLock(() => mem.defragment());
    n.write(3);
    expect(n.read()).toBe(3);
    expect(after.read()).toBe(9);
    expect(before.read()).toBe("y");
    mem.bumpLayoutVersion();
    n.write(4);
    expect(n.read()).toBe(4);
    expect(after.read()).toBe(9);
    mem.dispose();
  });

  test("a number replaces a string, and a string replaces it again", () => {
    const mem = new SharedMemory();
    const v = Shared<number | string>("fp-type", "abc", { memory: mem });
    v.write("def");
    v.write(5);
    expect(v.read()).toBe(5);
    v.write(6);
    expect(v.read()).toBe(6);
    v.write("back");
    expect(v.read()).toBe("back");
    mem.dispose();
  });

  test("a write is seen by a second wrapper on the same memory", () => {
    const mem = new SharedMemory();
    const a = Shared<number>("fp-two", 1, { memory: mem });
    const b = Shared<number>("fp-two", 1, { memory: mem });
    a.write(2);
    a.write(3);
    expect(b.read()).toBe(3);
    b.write(4);
    expect(a.read()).toBe(4);
    mem.dispose();
  });

  test("boolean, bigint and inline string writes land and switch types", () => {
    const mem = new SharedMemory();
    const v = Shared<boolean | bigint | string | number>("fp-small", true, {
      memory: mem,
    });
    v.write(false);
    for (const x of [true, 5n, -9n, "hi", "hello world", 3, "", false]) {
      v.write(x);
      expect(v.read()).toBe(x);
    }
    // Outside int64 and longer than 11 bytes: general path.
    v.write(2n ** 70n);
    expect(v.read()).toBe(2n ** 70n);
    v.write("this string does not fit inline");
    expect(v.read()).toBe("this string does not fit inline");
    v.write("héllo wörld"); // 11 units but more than 11 UTF-8 bytes
    expect(v.read()).toBe("héllo wörld");
    mem.dispose();
  });

  test("object property writes of every small type, also inside a lock", () => {
    const mem = new SharedMemory();
    const o = Shared(
      "fp-obj",
      { n: 1, s: "x", b: false, g: 1n } as Record<string, unknown>,
      { memory: mem },
    );
    o.n = 2;
    o.s = "y";
    o.n = 5;
    o.s = "abc";
    o.b = true;
    o.g = 7n;
    expect(o.read()).toEqual({ n: 5, s: "abc", b: true, g: 7n });
    o.s = "a string that is too long to be inline";
    o.n = "now a string";
    expect(o.read()).toEqual({
      n: "now a string",
      s: "a string that is too long to be inline",
      b: true,
      g: 7n,
    });
    (
      o as unknown as { withWriteLock(f: (s: any) => void): void }
    ).withWriteLock((self) => {
      self.n = 1;
      self.b = false;
    });
    expect(o.read()).toMatchObject({ n: 1, b: false });
    mem.dispose();
  });

  test("array index writes of every small type, also inside a lock", () => {
    const mem = new SharedMemory();
    const a = Shared<unknown[]>("fp-arr", [1, 2, 3, 4], { memory: mem });
    a[0] = 9;
    a[1] = 8; // the cached ArrayRef is warm now
    a[2] = true;
    a[3] = 5n;
    expect(a.read()).toEqual([9, 8, true, 5n]);
    a[0] = "hi";
    a[1] = "a string that is too long to be inline";
    a[2] = 2n ** 70n;
    expect(a.read()).toEqual([
      "hi",
      "a string that is too long to be inline",
      2n ** 70n,
      5n,
    ]);
    a[3] = 4;
    expect(a.read()[3]).toBe(4);
    expect(() => {
      a[4] = 1;
    }).toThrow(RangeError);
    (
      a as unknown as { withWriteLock(f: (s: any) => void): void }
    ).withWriteLock((self) => {
      self[0] = 11;
      self[1] = 12;
    });
    expect(a.read().slice(0, 2)).toEqual([11, 12]);
    mem.dispose();
  });
});
