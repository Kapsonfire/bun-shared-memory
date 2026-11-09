import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

describe("Index Table with many keys", () => {
  test("creating and resolving many keys stays fast (no quadratic key scan)", () => {
    const mem = new SharedMemory();
    const N = 10_000;

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      Shared(`many-${i}`, { v: i }, { memory: mem });
    }
    const createMs = performance.now() - t0;

    // Every key resolves to its own stable index and value.
    for (const i of [0, 1, 4999, 9999]) {
      expect(mem.lookupIndex(`many-${i}`)).toBe(i);
      expect(mem.getKeyByIndex(i)).toBe(`many-${i}`);
      expect(Shared(`many-${i}`, { v: -1 }, { memory: mem }).v).toBe(i);
    }
    expect(mem.lookupIndex("not-there")).toBeNull();

    // The old linear scan needed ~15 s for 10k keys; the incremental key
    // index needs well under a second. The bound is generous for slow CI.
    expect(createMs).toBeLessThan(4000);
  });

  test("lookups see keys appended after an earlier lookup", () => {
    const mem = new SharedMemory();
    Shared("first", { v: 1 }, { memory: mem });
    expect(mem.lookupIndex("second")).toBeNull();
    Shared("second", { v: 2 }, { memory: mem });
    expect(mem.lookupIndex("second")).toBe(1);
  });
});

describe("Index Table insert ordering", () => {
  test("the entry is fully written before the count is published", () => {
    const mem = new SharedMemory();
    Shared("a", { v: 1 }, { memory: mem });
    const before = mem.indexTable.getInt32(0);

    // Record the published count at every Index Table write during an insert.
    const countsSeen: number[] = [];
    const table = mem.indexTable;
    const original = table.setInt32.bind(table);
    table.setInt32 = (offset: number, value: number) => {
      countsSeen.push(table.getInt32(0));
      original(offset, value);
    };
    mem.insert("b", 0);
    table.setInt32 = original;

    expect(countsSeen.length).toBeGreaterThan(0);
    // While the entry's fields are being written, a lock-free reader must
    // still see the old count, i.e. never the half-written entry.
    expect(countsSeen.every((c) => c === before)).toBe(true);
    expect(table.getInt32(0)).toBe(before + 1);
  });
});

describe("concurrent key creation from several workers", () => {
  test("no key is lost or duplicated and readers never see a torn entry", async () => {
    const WORKERS = 4;
    const PER_WORKER = 400;
    const mem = new SharedMemory();
    const buffers = mem.exportBuffers();

    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const { buffers, id, n } = e.data;
        const mem = SharedMemory.fromBuffers(buffers);
        // Every worker races to create the same key: only one may win.
        Shared("race-shared", { owner: id }, { memory: mem });
        for (let j = 0; j < n; j++) {
          Shared("race-" + id + "-" + j, { v: id * 100000 + j }, { memory: mem });
        }
        self.postMessage("done");
      };
    `;
    const url = new URL(
      "data:text/javascript," + encodeURIComponent(code),
      import.meta.url,
    );
    let pending = WORKERS;
    const workers: Worker[] = [];
    const allDone = new Promise<void>((resolve, reject) => {
      for (let id = 0; id < WORKERS; id++) {
        const w = new Worker(url, { type: "module" });
        workers.push(w);
        w.onerror = (e) => reject(e);
        w.onmessage = () => {
          if (--pending === 0) resolve();
        };
        w.postMessage({ buffers, id, n: PER_WORKER });
      }
    });

    // While the workers insert keys, read the Index Table lock-free from the
    // main thread: the newest published entry must always be a complete key.
    let sampled = 0;
    let finished = false;
    void allDone.then(() => (finished = true));
    while (!finished) {
      const count = mem.indexTable.getInt32(0);
      if (count > 0) {
        expect(mem.getKeyByIndex(count - 1)).toMatch(/^race-/);
        sampled++;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    await allDone;
    workers.forEach((w) => w.terminate());
    expect(sampled).toBeGreaterThan(0);

    // Exactly one entry per key (the shared key was created once).
    expect(mem.indexTable.getInt32(0)).toBe(WORKERS * PER_WORKER + 1);
    for (let id = 0; id < WORKERS; id++) {
      for (const j of [0, PER_WORKER - 1]) {
        const key = `race-${id}-${j}`;
        expect(mem.lookupIndex(key)).not.toBeNull();
        expect(Shared(key, { v: -1 }, { memory: mem }).v).toBe(id * 100000 + j);
      }
    }
    const owner = Shared("race-shared", { owner: -1 }, { memory: mem }).owner;
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThan(WORKERS);
  });
});
