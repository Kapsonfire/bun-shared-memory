import { describe, expect, test } from "bun:test";
import { Shared } from "../src/index.ts";
import { sharedCacheStats } from "../src/shared.ts";

/** Run the GC and let the FinalizationRegistry callbacks run. */
async function collect(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    Bun.gc(true);
    await Bun.sleep(10);
  }
}

describe("wrappers are collected", () => {
  test("unreferenced wrappers and their cache entries are freed", async () => {
    const before = sharedCacheStats();
    // Create and read many keys without keeping the references.
    (() => {
      for (let i = 0; i < 2000; i++) {
        const o = Shared(`gc-obj-${i}`, { n: i, s: "x" });
        void o.n;
        const p = Shared(`gc-num-${i}`, i);
        void p.read();
      }
    })();
    const grown = sharedCacheStats();
    expect(grown.wrappers - before.wrappers).toBe(4000);
    await collect();
    const after = sharedCacheStats();
    expect(after.wrappers - before.wrappers).toBeLessThan(200);
    expect(after.readCache - before.readCache).toBeLessThan(200);
    expect(after.indexCache - before.indexCache).toBeLessThan(200);
  });

  test("a collected key can be used again and keeps its value", async () => {
    (() => {
      const o = Shared("gc-again", { n: 1 });
      o.n = 42;
    })();
    await collect();
    // The initial value is ignored: the key exists in shared memory.
    const again = Shared("gc-again", { n: 0 });
    expect(again.n).toBe(42);
    again.n = 43;
    expect(Shared("gc-again", { n: 0 }).n).toBe(43);
  });

  test("a held reference stays the same object for the same key", async () => {
    const a = Shared("gc-held", { n: 1 });
    await collect();
    expect(Shared("gc-held", { n: 2 })).toBe(a);
    expect(a.n).toBe(1);
  });

  test("a nested Shared reference still resolves after its wrapper was collected", async () => {
    const inner = Shared("gc-inner", { v: 7 });
    const outer = Shared("gc-outer", { child: inner });
    expect(outer.child.v).toBe(7);
    await collect();
    // `inner` is still held here, so the same wrapper is returned.
    expect((outer.child as unknown as { v: number }).v).toBe(7);
    inner.v = 8;
    expect(outer.child.v).toBe(8);
  });
});
