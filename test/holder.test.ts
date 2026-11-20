import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

/**
 * Holder masks: each key's 64-bit mask (as two Int32 halves) tracks which
 * threads hold a live wrapper for it. Bit 0 is the main thread, bits 1..63
 * are coordinator-registered workers. A defragmentation reclaims a key's value
 * block only when the mask is zero; an explicit clear lets it go.
 */
describe("holder masks", () => {
  test("a fresh key is held by the creating thread", () => {
    const mem = new SharedMemory();
    Shared("hm-fresh", { n: 1 }, { memory: mem });
    const index = mem.lookupIndex("hm-fresh")!;
    // Main thread = bit 0, so lo === 1.
    expect(mem.holderMask(index)).toEqual({ lo: 1, hi: 0 });
    expect(mem.hasNoHolders(index)).toBe(false);
  });

  test("addHolder/removeHolder set and clear individual bits", () => {
    const mem = new SharedMemory();
    Shared("hm-bits", { n: 1 }, { memory: mem });
    const index = mem.lookupIndex("hm-bits")!;
    expect(mem.holderMask(index)).toEqual({ lo: 1, hi: 0 });

    mem.addHolder(index, 2); // bit 2
    mem.addHolder(index, 7); // bit 7
    expect(mem.holderMask(index)).toEqual({ lo: 1 | (1 << 2) | (1 << 7), hi: 0 });

    mem.removeHolder(index, 7);
    expect(mem.holderMask(index)).toEqual({ lo: 1 | (1 << 2), hi: 0 });

    mem.removeHolder(index, 2);
    mem.removeHolder(index, 0); // main thread drops
    expect(mem.hasNoHolders(index)).toBe(true);
    expect(mem.holderMask(index)).toEqual({ lo: 0, hi: 0 });
  });

  test("the high half holds worker shifts 32..63", () => {
    const mem = new SharedMemory();
    Shared("hm-hi", { n: 1 }, { memory: mem });
    const index = mem.lookupIndex("hm-hi")!;
    mem.addHolder(index, 32);
    mem.addHolder(index, 63);
    // Bits 32 and 63 land in the hi half as bit0 and bit31.
    expect(mem.holderMask(index)).toEqual({
      lo: 1,
      hi: (1 << 0) | (1 << 31),
    });
    mem.removeHolder(index, 63);
    expect(mem.holderMask(index)).toEqual({ lo: 1, hi: 1 });
  });

  test("clearAllHolders clears every thread's bit at once", () => {
    const mem = new SharedMemory();
    Shared("hm-clear", { n: 1 }, { memory: mem });
    const index = mem.lookupIndex("hm-clear")!;
    mem.addHolder(index, 4);
    mem.addHolder(index, 33);
    mem.clearAllHolders(index);
    expect(mem.hasNoHolders(index)).toBe(true);
  });

  test("clearWorkerHolders releases only the given worker's keys", () => {
    const mem = new SharedMemory();
    Shared("hm-w-a", { n: 1 }, { memory: mem });
    Shared("hm-w-b", { n: 2 }, { memory: mem });
    const aIdx = mem.lookupIndex("hm-w-a")!;
    const bIdx = mem.lookupIndex("hm-w-b")!;
    // Worker 9 holds both, worker 3 holds only b.
    mem.addHolder(aIdx, 9);
    mem.addHolder(bIdx, 9);
    mem.addHolder(bIdx, 3);

    mem.clearWorkerHolders(9);
    // Worker 9's bit is gone everywhere; worker 3's bit on b stays.
    expect(mem.holderMask(aIdx)).toEqual({ lo: 1, hi: 0 });
    expect(mem.holderMask(bIdx)).toEqual({ lo: 1 | (1 << 3), hi: 0 });
  });
});

describe("reclamation and holder masks", () => {
  /**
   * A key whose wrapper is dropped and whose mask reaches zero has its value
   * block reclaimed by the next defragmentation (the data offset becomes the
   * tombstone); a held key keeps its value through the same garbage-collect /
   * defrag cycles.
   */
  test("an unheld key is reclaimed, a held key survives a defrag", async () => {
    const mem = new SharedMemory();
    // This wrapper is dropped via GC (never referenced again after this block).
    (() => {
      const d = Shared("hm-drop", { n: 1 }, { memory: mem });
      d.n = 1;
    })();
    // This wrapper is retained and referenced, so its holder bit stays set.
    const keep = Shared("hm-keep", { n: 2 }, { memory: mem });
    keep.n = 2;

    const droppedIdx = mem.lookupIndex("hm-drop")!;
    const keptIdx = mem.lookupIndex("hm-keep")!;
    // Both are held right now (the dropped wrapper is still alive).
    expect(mem.holderMask(droppedIdx).lo).toBe(1);
    expect(mem.holderMask(keptIdx).lo).toBe(1);

    // Let the GC collect the dropped wrapper; its FinalizationRegistry
    // callback clears bit 0.
    for (let i = 0; i < 5; i++) {
      Bun.gc(true);
      await Bun.sleep(10);
    }

    mem.reclaimInPlace();
    // The kept value is untouched; the dropped key's value was reclaimed.
    expect(keep.n).toBe(2);
    expect(mem.hasNoHolders(keptIdx)).toBe(false);
  });
});
