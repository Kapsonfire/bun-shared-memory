import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

/**
 * Differential test: random operations on shared arrays are applied to a plain
 * JS model as well, and the shared value must equal the model after every step
 * (and throw a `RangeError` exactly where the model is out of bounds). It
 * covers the write caches (`ArrayRef`, offsets, types, property slots) across
 * whole-value writes, push/pop/`length`, array growth, defragmentation and
 * writes into arrays nested in arrays. Seeded, so a failure repeats.
 */

const CAP = 8;

function prng(seed: number): {
  int(n: number): number;
  chance(p: number): boolean;
} {
  let s = (seed * 7919) >>> 0 || 1;
  const next = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return { int: (n) => Math.floor(next() * n), chance: (p) => next() < p };
}

const show = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}n` : v));

function values(r: ReturnType<typeof prng>): unknown {
  const all: unknown[] = [
    r.int(1000),
    -r.int(50) - 0.5,
    true,
    false,
    "hi",
    "hello wor",
    "a long string value here",
    5n,
    2n ** 70n,
    "é",
  ];
  return all[r.int(all.length)];
}

/** `arr[i] = v`; true when it threw a RangeError (any other error fails). */
function setIndex(arr: unknown[], i: number, v: unknown): boolean {
  try {
    arr[i] = v;
    return false;
  } catch (e) {
    if (e instanceof RangeError) return true;
    throw e;
  }
}

function runSequence(
  seed: number,
  shape: "top" | "prop" | "nested",
  steps: number,
): void {
  const r = prng(seed);
  const mem = new SharedMemory({ initialSize: 4096, maxByteLength: 1 << 24 });
  try {
    let model: any =
      shape === "top"
        ? [1, 2, 3, 4]
        : shape === "prop"
          ? { tags: [1, 2, 3, 4], n: 1 }
          : {
              tags: [
                [1, 2, 3],
                [4, 5],
              ],
              n: 1,
            };
    const ref: any = Shared(`m-${shape}-${seed}`, structuredClone(model), {
      memory: mem,
      arrayCapacity: CAP,
    });
    Shared(`other-${seed}`, { x: [1, 2, 3] }, { memory: mem });

    // The array an operation works on, in the shared value and in the model.
    const target = (): { shared: any; model: unknown[] } | undefined => {
      if (shape === "top") return { shared: ref, model };
      if (shape === "prop") return { shared: ref.tags, model: model.tags };
      const i = r.int(model.tags.length);
      const inner = model.tags[i];
      return inner === undefined
        ? undefined
        : { shared: ref.tags[i], model: inner };
    };

    for (let step = 0; step < steps; step++) {
      let op = "";
      const kind = r.int(10);
      const t = kind <= 6 ? target() : undefined;
      if (kind <= 2 && t) {
        const i = r.int(CAP + 1);
        const v = values(r);
        op = `[${i}] = ${String(v)}`;
        const threw = setIndex(t.shared, i, v);
        if (i >= t.model.length) {
          expect(threw, `step ${step}: ${op} out of bounds`).toBe(true);
        } else {
          expect(threw, `step ${step}: ${op} in bounds`).toBe(false);
          t.model[i] = v;
        }
      } else if (kind === 3 && t) {
        const v = values(r);
        op = `push(${String(v)})`;
        t.shared.push(v);
        t.model.push(v);
      } else if (kind === 4 && t) {
        op = "pop()";
        t.shared.pop();
        t.model.pop();
      } else if (kind === 5 && t) {
        const k = r.int(t.model.length + 1);
        op = `length = ${k}`;
        t.shared.length = k;
        t.model.length = k;
      } else if (kind === 6 && t) {
        // A whole new array in place of this one.
        const x = Array.from({ length: r.int(7) }, () => values(r));
        op = `whole write of ${x.length} elements`;
        if (shape === "top") {
          ref.write(x);
          model = x;
        } else if (shape === "prop") {
          ref.write({ tags: x, n: model.n });
          model.tags = x;
        } else {
          const nested = [x, [1, 2]];
          ref.write({ tags: nested, n: model.n });
          model.tags = nested;
        }
      } else if (kind === 7 && shape !== "top") {
        const v = values(r);
        op = `n = ${String(v)}`;
        ref.n = v;
        model.n = v;
      } else if (kind === 8) {
        op = "defragment";
        mem.withLock(() => mem.defragment());
      }
      expect(
        show(ref.read()),
        `seed ${seed} ${shape} step ${step}: ${op}`,
      ).toBe(show(model));
      // Element reads through the proxy, twice (the second one is the cached
      // path), including one past the end.
      const views: Array<[any, unknown[]]> =
        shape === "top"
          ? [[ref, model]]
          : shape === "prop"
            ? [[ref.tags, model.tags]]
            : model.tags.map((m: unknown[], i: number) => [ref.tags[i], m]);
      for (const [shared, m] of views) {
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i <= m.length; i++) {
            expect(
              show(shared[i]),
              `seed ${seed} ${shape} step ${step}: ${op}, element ${i}`,
            ).toBe(show(m[i]));
          }
        }
      }
    }
  } finally {
    mem.dispose();
  }
}

describe("shared arrays follow a plain JS model", () => {
  for (const shape of ["top", "prop", "nested"] as const) {
    test(`${shape}: 40 random sequences`, () => {
      for (let seed = 1; seed <= 40; seed++) runSequence(seed, shape, 70);
    });
  }
});
