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

type Model = { p: { q: unknown; r: { s: unknown } }; n: unknown };

function run(seed: number, steps: number): void {
  const r = prng(seed);
  const mem = new SharedMemory({ initialSize: 4096, maxByteLength: 1 << 24 });
  try {
    const model: Model = { p: { q: 1, r: { s: "x" } }, n: 0 };
    const o: any = Shared(`nested-${seed}`, structuredClone(model), {
      memory: mem,
    });
    Shared(`filler-${seed}`, { a: [1, 2, 3], b: "filler" }, { memory: mem });
    const heldP = o.p;
    const heldR = o.p.r;
    for (let step = 0; step < steps; step++) {
      let op = "";
      const k = r.int(8);
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
          p: { q: leaf(r), r: { s: leaf(r) } },
          n: leaf(r),
        };
        op = `o.write(${show(next)})`;
        o.write(structuredClone(next));
        model.p = next.p;
        model.n = next.n;
      } else if (k === 5) {
        const p = { q: leaf(r), r: { s: leaf(r) } };
        op = `o.p = ${show(p)}`;
        o.p = structuredClone(p);
        model.p = p;
      } else if (k === 6) {
        op = `o.n = ${String(v)}`;
        o.n = v;
        model.n = v;
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
        expect(heldP.missing, `${where} (missing)`).toBeUndefined();
        expect(heldP.toString, `${where} (toString)`).toBeUndefined();
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
