import { describe, expect, test } from "bun:test";
import { Shared } from "../src/index.ts";

describe("ref objects share their prototype and methods", () => {
  test("object refs of different keys share one prototype and the methods", () => {
    const a = Shared("shape-a", { n: 1, s: "x" });
    const b = Shared("shape-b", { n: 2, s: "y" });
    expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b));
    expect(a.read).toBe(b.read);
    // The shared methods still act on their own key.
    expect(a.read()).toEqual({ n: 1, s: "x" });
    expect(b.read()).toEqual({ n: 2, s: "y" });
    a.write({ n: 10, s: "z" });
    expect(a.n).toBe(10);
    expect(b.n).toBe(2);
    expect(a.update((v) => ({ ...v, n: v.n + 1 })).n).toBe(11);
  });

  test("the hidden target does not show up in keys, JSON or spread", () => {
    const o = Shared("shape-hidden", { n: 1, s: "x" });
    expect(Object.keys(o)).toEqual(["n", "s"]);
    expect(JSON.parse(JSON.stringify(o))).toEqual({ n: 1, s: "x" });
    expect(Object.getOwnPropertySymbols({ ...o })).toEqual([]);
    expect(o.key).toBe("shape-hidden");
    expect(o.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(`${Shared("shape-prim", 7)}`).toBe("7");
    expect(Number(o.n) + 1).toBe(2);
  });

  test("lock callbacks get the ref, for objects and for proxies", () => {
    const o = Shared("shape-lock", { n: 1 });
    o.withWriteLock((self) => {
      self.n = 5;
    });
    expect(o.n).toBe(5);
    const list = Shared<number[]>("shape-lock-arr", [1, 2]);
    expect(list.withReadLock((self) => self.length)).toBe(2);
    list.withWriteLock((self) => {
      self.push(3);
    });
    expect(list.read()).toEqual([1, 2, 3]);
  });

  test("array and primitive proxies share the methods too", () => {
    const x = Shared<number[]>("shape-arr-1", [1]);
    const y = Shared<number[]>("shape-arr-2", [2]);
    expect(x.read).toBe(y.read);
    expect(x.read()).toEqual([1]);
    expect(y.read()).toEqual([2]);
    const p = Shared("shape-num", 3);
    p.write(4);
    expect(p.update((n) => n + 1)).toBe(5);
  });
});
