import { describe, expect, test } from "bun:test";
import { Shared } from "../src/index.ts";

describe("Shared(key, loader)", () => {
  test("concurrent calls share one load and all get a Promise", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      await Bun.sleep(20);
      return { n: 1 };
    };
    const a = Shared("ld-conc", loader);
    const b = Shared("ld-conc", loader);
    expect(a).toBeInstanceOf(Promise);
    expect(b).toBeInstanceOf(Promise);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(calls).toBe(1);
    expect(ra.n).toBe(1);
    // Cached wrapper: still a Promise for the loader overload.
    const c = Shared("ld-conc", loader);
    expect(c).toBeInstanceOf(Promise);
    expect(await c).toBe(ra);
  });

  test("a failing loader leaves no poisoned key and can be retried", async () => {
    await expect(
      Shared("ld-fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const ref = await Shared("ld-fail", () => ({ ok: true }));
    expect(ref.ok).toBe(true);
  });

  test("the loader is skipped when the key already exists", async () => {
    Shared("ld-exists", { v: 7 });
    let called = false;
    const ref = await Shared("ld-exists", () => {
      called = true;
      return { v: 99 };
    });
    expect(ref.v).toBe(7);
    expect(called).toBe(false);
  });
});

describe("unsupported value types", () => {
  test("Date, Map, Set, RegExp are rejected instead of becoming {}", () => {
    expect(() => Shared("ty-date", new Date())).toThrow(/Date/);
    const holder = Shared("ty-holder", { inner: { a: 1 }, n: 1 });
    expect(() => holder.write({ inner: new Map() as never, n: 1 })).toThrow(
      /Map/,
    );
    expect(() => holder.write({ inner: new Set() as never, n: 1 })).toThrow(
      /Set/,
    );
    expect(() => holder.write({ inner: /x/ as never, n: 1 })).toThrow(/RegExp/);
    // The failed writes left the value untouched.
    expect(holder.read()).toEqual({ inner: { a: 1 }, n: 1 });
  });

  test("a Date nested in an array is rejected", () => {
    const list = Shared<unknown[]>("ty-list", [1]);
    expect(() => list.write([new Date()])).toThrow(/Date/);
  });

  test("sparse arrays are rejected with a clear message", () => {
    const list = Shared<unknown[]>("ty-sparse", [1]);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => list.write([1, , 3])).toThrow(/sparse array/);
  });

  test("class instances with data properties are still accepted", () => {
    class P {
      x = 1;
      y = 2;
    }
    const p = Shared("ty-class", new P());
    expect(p.x).toBe(1);
  });
});
