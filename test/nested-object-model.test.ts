import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

/**
 * Differential test for nested plain objects: random writes (through fresh and
 * held nested proxies, whole-value writes, replacing a sub-object,
 * defragmentation) are applied to a JS model too, and every way of reading a
 * nested property must agree with it after each step. Property reads of a
 * nested object answer from the cached decoded root, so this pins down that
 * the cache is never served stale.
 */

function prng(seed: number) {
  let s = (seed * 104729) >>> 0 || 1;
  const next = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return { int: (n: number) => Math.floor(next() * n) };
}

const show = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}n` : v));

function leaf(r: ReturnType<typeof prng>): unknown {
  const all: unknown[] = [
    r.int(1000),
    -1.5,
    true,
    false,
    null,
    "hi",
    "a long string value here",
    7n,
    2n ** 70n,
  ];
  return all[r.int(all.length)];
}

function list(r: ReturnType<typeof prng>): unknown[] {
  return Array.from({ length: r.int(5) }, () => leaf(r));
}

type Model = {
  p: { q: unknown; r: { s: unknown }; t: unknown[] };
  n: unknown;
};

function run(seed: number, steps: number): void {
  const r = prng(seed);
  const mem = new SharedMemory({ initialSize: 4096, maxByteLength: 1 << 24 });
  try {
    const model: Model = { p: { q: 1, r: { s: "x" }, t: [1, 2, 3] }, n: 0 };
    const o: any = Shared(`nested-${seed}`, structuredClone(model), {
      memory: mem,
    });
    Shared(`filler-${seed}`, { a: [1, 2, 3], b: "filler" }, { memory: mem });
    const heldP = o.p;
    const heldR = o.p.r;
    const heldT = o.p.t;
    const arr = (): unknown[] => (r.int(2) === 0 ? o.p.t : heldT);
    for (let step = 0; step < steps; step++) {
      let op = "";
      try {
        const k = r.int(12);
        const v = leaf(r);
        if (k === 0) {
          op = `o.p.q = ${String(v)}`;
          o.p.q = v;
          model.p.q = v;
        } else if (k === 1) {
          op = `held p.q = ${String(v)}`;
          heldP.q = v;
          model.p.q = v;
        } else if (k === 2) {
          op = `o.p.r.s = ${String(v)}`;
          o.p.r.s = v;
          model.p.r.s = v;
        } else if (k === 3) {
          op = `held r.s = ${String(v)}`;
          heldR.s = v;
          model.p.r.s = v;
        } else if (k === 4) {
          const next: Model = {
            p: { q: leaf(r), r: { s: leaf(r) }, t: list(r) },
            n: leaf(r),
          };
          op = `o.write(${show(next)})`;
          o.write(structuredClone(next));
          model.p = next.p;
          model.n = next.n;
        } else if (k === 5) {
          const p = { q: leaf(r), r: { s: leaf(r) }, t: list(r) };
          op = `o.p = ${show(p)}`;
          o.p = structuredClone(p);
          model.p = p;
        } else if (k === 6) {
          op = `o.n = ${String(v)}`;
          o.n = v;
          model.n = v;
        } else if (k === 7) {
          // An array inside the nested object, through a fresh or held proxy.
          const i = r.int(6);
          op = `p.t[${i}] = ${String(v)}`;
          let threw = false;
          try {
            arr()[i] = v;
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            threw = true;
          }
          expect(threw, `seed ${seed} step ${step}: ${op}`).toBe(
            i >= model.p.t.length,
          );
          if (!threw) model.p.t[i] = v;
        } else if (k === 8) {
          op = `p.t.push(${String(v)})`;
          arr().push(v);
          model.p.t.push(v);
        } else if (k === 9) {
          op = "p.t.pop()";
          arr().pop();
          model.p.t.pop();
        } else if (k === 10) {
          const n = r.int(model.p.t.length + 1);
          op = `p.t.length = ${n}`;
          arr().length = n;
          model.p.t.length = n;
        } else {
          op = "defragment";
          mem.withLock(() => mem.defragment());
        }
        const where = `seed ${seed} step ${step}: ${op}`;
        // Twice: the second read is the cached path.
        for (let pass = 0; pass < 2; pass++) {
          expect(show(o.read()), where).toBe(show(model));
          expect(show(o.p.q), `${where} (o.p.q)`).toBe(show(model.p.q));
          expect(o.p.r, `${where} (o.p.r)`).toBeDefined();
          expect(show(o.p.r.s), `${where} (o.p.r.s)`).toBe(show(model.p.r.s));
          expect(show(heldP.q), `${where} (held p.q)`).toBe(show(model.p.q));
          expect(show(heldR.s), `${where} (held r.s)`).toBe(show(model.p.r.s));
          expect(show(o.n), `${where} (o.n)`).toBe(show(model.n));
          for (const [name, t] of [
            ["o.p.t", o.p.t],
            ["held t", heldT],
          ] as const) {
            expect(t.length, `${where} (${name}.length)`).toBe(
              model.p.t.length,
            );
            for (let i = 0; i <= model.p.t.length; i++) {
              expect(show(t[i]), `${where} (${name}[${i}])`).toBe(
                show(model.p.t[i]),
              );
            }
          }
          expect(heldP.missing, `${where} (missing)`).toBeUndefined();
          expect(heldP.toString, `${where} (toString)`).toBeUndefined();
        }
      } catch (e) {
        if (e instanceof Error && !e.message.startsWith("seed ")) {
          e.message = `seed ${seed} step ${step}: ${op}: ${e.message}`;
        }
        throw e;
      }
    }
  } finally {
    mem.dispose();
  }
}

describe("nested objects follow a plain JS model", () => {
  test("40 random sequences", () => {
    for (let seed = 1; seed <= 40; seed++) run(seed, 60);
  });
});

/**
 * The nested proxy remembers the cache entry of the property read last, so a
 * repeated read of one property skips the per-name Map. Every kind of write
 * and the switch between properties must still give the current value.
 */
describe("nested proxy: last-read property", () => {
  test("repeated reads stay current across every kind of write", () => {
    const mem = new SharedMemory();
    const o = Shared<{ id: number; address: Record<string, unknown> }>(
      "nest-last",
      { id: 0, address: { city: "Berlin", zip: 10115, n: 3 } },
      { memory: mem },
    );
    const a = o.address;
    expect(a.zip).toBe(10115);
    expect(a.zip).toBe(10115);

    a.zip = 1; // through the held proxy
    expect(a.zip).toBe(1);
    expect(a.zip).toBe(1);

    o.address.zip = 2; // through a fresh access
    expect(a.zip).toBe(2);
    expect(a.zip).toBe(2);

    o.id = 5; // another property of the key: version bump, same value
    expect(a.zip).toBe(2);

    o.address = { city: "Hamburg", zip: 20095, n: 4 }; // sub-object replaced
    expect(a.zip).toBe(20095);
    expect(a.zip).toBe(20095);

    o.write({ id: 6, address: { city: "Köln", zip: 50667, n: 5 } }); // whole value
    expect(a.zip).toBe(50667);
    expect(a.zip).toBe(50667);

    // Switching between properties.
    for (let i = 0; i < 3; i++) {
      expect(a.city).toBe("Köln");
      expect(a.zip).toBe(50667);
      expect(a.n).toBe(5);
    }
    a.n = 9;
    expect(a.zip).toBe(50667);
    expect(a.n).toBe(9);
    expect(a.n).toBe(9);
  });

  test("still current after the per-name cache was cleared", () => {
    const mem = new SharedMemory();
    const o = Shared<{ address: Record<string, unknown> }>(
      "nest-clear",
      { address: { zip: 1 } },
      { memory: mem },
    );
    const a = o.address;
    expect(a.zip).toBe(1);
    expect(a.zip).toBe(1);
    // Names the object does not have also get entries; enough of them clear
    // the per-name cache while `zip` stays the remembered entry.
    for (let i = 0; i < 300; i++) expect(a[`missing${i}`]).toBeUndefined();
    expect(a.zip).toBe(1);
    expect(a.zip).toBe(1);
    a.zip = 2;
    expect(a.zip).toBe(2);
    expect(a.zip).toBe(2);
  });
});

/**
 * Plain writes through a nested proxy reuse the slot offsets of their last
 * walk from the root. A replaced sub-object (new block), a whole-value write
 * and a defragmentation (moved blocks) must make the next write land in the
 * current block.
 */
describe("nested proxy: plain-write fast path", () => {
  test("writes follow replaced blocks and defragmentation", () => {
    const mem = new SharedMemory();
    const o = Shared<{ id: number; a: { b: { x: unknown; y: unknown } } }>(
      "nest-fastw",
      { id: 0, a: { b: { x: 1, y: "s" } } },
      { memory: mem },
    );
    const b = o.a.b;
    b.x = 2;
    b.x = 3;
    b.y = true;
    expect(o.read().a.b).toEqual({ x: 3, y: true });

    o.a = { b: { x: 10, y: 11 } }; // new blocks for a and b
    b.x = 12;
    expect(o.read().a.b).toEqual({ x: 12, y: 11 });

    o.a.b = { x: 20, y: 21 }; // new block for b only
    b.y = 22n;
    expect(o.read().a.b).toEqual({ x: 20, y: 22n });

    o.write({ id: 1, a: { b: { x: 30, y: 31 } } }); // whole value
    b.x = "short";
    expect(o.read()).toEqual({ id: 1, a: { b: { x: "short", y: 31 } } });

    mem.withLock(() => mem.defragment()); // blocks move, layout version bumps
    b.x = 40;
    b.y = false;
    expect(o.read()).toEqual({ id: 1, a: { b: { x: 40, y: false } } });

    // Values that leave the fast path still work and mix with it.
    b.y = "a string that is longer than eleven bytes";
    b.x = { not: "plain" } as unknown;
    b.x = 41;
    expect(o.read().a.b).toEqual({
      x: 41,
      y: "a string that is longer than eleven bytes",
    });
    expect(() => {
      (b as Record<string, unknown>).z = 1;
    }).toThrow(TypeError);
  });
});
