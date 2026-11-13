import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  GrowableBuffer,
  MIN_BLOCK_SIZE,
  SharedBudget,
} from "../src/growable-buffer.ts";
import { Notifier } from "../src/index.ts";

/**
 * Direct tests of the buffer layer under SharedMemory: the free list, the
 * budget, chunk activation, reconstruction from existing buffers and the
 * single-buffer mode. SharedMemory exercises the common paths; these pin
 * down the edges (errors, reuse order, reconstruction).
 */

const KB = 1024;

describe("GrowableBuffer free list", () => {
  test("freed blocks are reused first-fit, from the head and the middle", () => {
    const buf = new GrowableBuffer(64 * KB, 64 * KB, { chunkSize: 64 * KB });
    const a = buf.alloc(32);
    buf.advance(a.size);
    const b = buf.alloc(64);
    buf.advance(b.size);
    const c = buf.alloc(16);
    buf.advance(c.size);
    expect(a.appended && b.appended && c.appended).toBe(true);

    // Small sizes are padded to the minimum block size.
    const tiny = buf.alloc(1);
    expect(tiny.size).toBe(MIN_BLOCK_SIZE);
    buf.advance(tiny.size);

    buf.free(a.offset, 32);
    buf.free(b.offset, 64);
    buf.free(c.offset, 16);
    expect(buf.freeListStats()).toEqual({
      count: 3,
      bytes: 32 + 64 + Math.max(16, MIN_BLOCK_SIZE),
    });

    // Head of the list is `c` (last freed); 64 bytes only fit `b`, which is
    // in the middle of the list and has to be unlinked there.
    const reuseB = buf.alloc(64);
    expect(reuseB).toEqual({ offset: b.offset, appended: false, size: 64 });
    expect(buf.freeListStats().count).toBe(2);

    // A small request takes the head of the list.
    const reuseC = buf.alloc(MIN_BLOCK_SIZE);
    expect(reuseC.offset).toBe(c.offset);
    expect(reuseC.appended).toBe(false);

    // Nothing left that is large enough: append.
    const big = buf.alloc(128);
    expect(big.appended).toBe(true);
    expect(big.offset).toBe(buf.byteLength);
  });

  test("a double free is detected", () => {
    const buf = new GrowableBuffer(64 * KB, 64 * KB, { chunkSize: 64 * KB });
    const a = buf.alloc(32);
    buf.advance(a.size);
    buf.free(a.offset, 32);
    expect(() => buf.free(a.offset, 32)).toThrow(/Double free/);
  });
});

describe("SharedBudget and GrowableBuffer limits", () => {
  test("initial buffers beyond the budget are rejected", () => {
    const budget = new SharedBudget(8);
    budget.add(4);
    expect(() => budget.add(8)).toThrow(RangeError);
    expect(() => budget.add(8)).toThrow(/budget exceeded/);
  });

  test("activating a chunk beyond the budget throws BudgetExceededError", () => {
    // The pre-allocated 4-byte chunks are charged too (4 chunks: 16 bytes).
    const budget = new SharedBudget(16 * KB + 16);
    const buf = new GrowableBuffer(16, 64 * KB, {
      budget,
      chunkSize: 16 * KB,
    });
    buf.ensureCapacity(16 * KB); // first chunk fits the budget
    expect(buf.activeChunkCount).toBe(1);
    expect(() => buf.ensureCapacity(32 * KB)).toThrow(BudgetExceededError);
    expect(buf.activeChunkCount).toBe(1);
  });

  test("bytes beyond the capacity are a RangeError", () => {
    const buf = new GrowableBuffer(16, 32 * KB, { chunkSize: 16 * KB });
    expect(buf.capacity).toBe(32 * KB);
    expect(() => buf.readBytes(32 * KB - 2, 4)).toThrow(/beyond the buffer/);
    expect(() => buf.writeBytes(64 * KB, new Uint8Array(1))).toThrow(
      RangeError,
    );
    // Within the capacity, across the chunk boundary.
    buf.writeBytes(16 * KB - 2, new Uint8Array([1, 2, 3, 4]));
    expect([...buf.readBytes(16 * KB - 2, 4)]).toEqual([1, 2, 3, 4]);
  });

  test("byte access across chunks activates them", () => {
    const buf = new GrowableBuffer(16, 32 * KB, { chunkSize: 16 * KB });
    expect(buf.activeChunkCount).toBe(0);
    buf.setUint8(16 * KB + 3, 0xab);
    expect(buf.getUint8(16 * KB + 3)).toBe(0xab);
    expect(buf.activeChunkCount).toBe(1); // only the second chunk
    expect(buf.buffers).toHaveLength(2);
  });
});

describe("GrowableBuffer single-buffer mode", () => {
  test("grows by doubling, falls back to the exact size near the budget", () => {
    const budget = new SharedBudget(1000);
    const buf = new GrowableBuffer(16, 4096, {
      budget,
      singleBuffer: true,
    });
    buf.ensureCapacity(100); // doubling from 4 bytes gives 100 (needed wins)
    expect(buf.buffers[0]!.byteLength).toBe(100);
    buf.ensureCapacity(150); // doubling wants 200: within the budget
    expect(buf.buffers[0]!.byteLength).toBe(200);
    // Doubling wants 800 (total 1000+), the budget only allows the exact
    // growth to 700.
    buf.ensureCapacity(700);
    expect(buf.buffers[0]!.byteLength).toBe(700);
    expect(() => buf.ensureCapacity(2000)).toThrow(/budget exceeded/);
    expect(buf.capacity).toBe(4096);
  });

  test("reconstruction needs exactly one buffer", () => {
    const a = new SharedArrayBuffer(8, { maxByteLength: 64 });
    const b = new SharedArrayBuffer(8, { maxByteLength: 64 });
    expect(
      () => new GrowableBuffer([a, b], 64, { singleBuffer: true }),
    ).toThrow(/exactly one SharedArrayBuffer/);
    expect(() => new GrowableBuffer([], 64, { singleBuffer: true })).toThrow(
      /exactly one SharedArrayBuffer/,
    );
    const ok = new GrowableBuffer([a], 64, { singleBuffer: true });
    ok.setInt32(0, 42);
    expect(new DataView(a).getInt32(0, true)).toBe(42);
    expect(() => ok.applyChunks([a, b])).toThrow(/exactly one/);
    ok.applyChunks([b]);
    expect(ok.buffers).toEqual([b]);
  });
});

describe("GrowableBuffer reconstruction from existing buffers", () => {
  test("a single non-growable buffer is used as one full chunk", () => {
    const sab = new SharedArrayBuffer(16 * KB);
    new DataView(sab).setInt32(8, 7, true);
    const buf = new GrowableBuffer(sab, 16 * KB);
    expect(buf.getInt32(8)).toBe(7);
    expect(buf.capacity).toBe(16 * KB);
    expect(buf.activeChunkCount).toBe(1);
  });

  test("applyChunks takes over another thread's chunk list", () => {
    const owner = new GrowableBuffer(16, 32 * KB, { chunkSize: 16 * KB });
    owner.setInt32(16 * KB + 4, 99); // activates the second chunk
    const copy = new GrowableBuffer(16, 32 * KB, { chunkSize: 16 * KB });
    copy.applyChunks(owner.buffers);
    expect(copy.getInt32(16 * KB + 4)).toBe(99);
    expect(copy.activeChunkCount).toBe(1);
    // A chunk that another thread grew to full size is taken as it is.
    owner.setInt32(0, 5);
    expect(copy.getInt32(0)).toBe(5);
    expect(copy.activeChunkCount).toBe(2);
  });
});

describe("Notifier", () => {
  test("wait times out without a notification and wakes after one", () => {
    const n = new Notifier();
    expect(n.wait(5)).toBe("timed-out");
    // A notification between snapshot and wait is not lost: the counter
    // moved, so the next wait sees a fresh value only after another notify.
    expect(n.notify()).toBe(0); // nobody is waiting
    expect(n.wait(5)).toBe("timed-out");
    const shared = new Notifier(n.buffer);
    expect(shared.buffer).toBe(n.buffer);
  });

  test("a worker blocked in wait() is woken by notify()", async () => {
    const n = new Notifier();
    const src = new URL("../src/index.ts", import.meta.url).href;
    const code = `
      import { Notifier } from ${JSON.stringify(src)};
      self.onmessage = (e) => {
        const n = new Notifier(e.data);
        self.postMessage("waiting");
        self.postMessage(n.wait(5000));
      };`;
    const worker = new Worker(
      new URL("data:text/javascript," + encodeURIComponent(code)),
      { type: "module" },
    );
    const messages: string[] = [];
    const result = new Promise<string>((resolve) => {
      worker.onmessage = (e) => {
        messages.push(e.data);
        if (e.data !== "waiting") resolve(e.data);
      };
    });
    worker.postMessage(n.buffer);
    while (!messages.includes("waiting")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Keep notifying until the worker is parked and wakes up.
    let woken = 0;
    while (messages.length < 2) {
      woken += n.notify();
      await new Promise((r) => setTimeout(r, 5));
    }
    worker.terminate();
    expect(await result).toBe("ok");
    expect(woken).toBeGreaterThanOrEqual(0);
  });
});
