import { describe, expect, test } from "bun:test";
import {
  LockTimeoutError,
  Shared,
  SharedMemory,
  getDefaultLockTimeout,
  setDefaultLockTimeout,
} from "../src/index.ts";

const SRC = new URL("../src/index.ts", import.meta.url).href;

function spawn(code: string): Worker {
  return new Worker(
    new URL(
      "data:text/javascript," + encodeURIComponent(code),
      import.meta.url,
    ),
    { type: "module" },
  );
}

describe("ordinary writes vs lock-free reads (seqlock)", () => {
  test("a reader never sees a value assembled from two writes", async () => {
    const A = "AAAAAAAAAAA"; // 11 characters: inline string, three payload words
    const B = "BBBBBBBBBBB";
    const LA = "a".repeat(20); // heap strings of different lengths
    const LB = "b".repeat(60);
    const mem = new SharedMemory();
    const o = Shared("seq-torn", { s: A, h: LA, n: 1.5 }, { memory: mem });
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(SRC)};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data);
        const o = Shared("seq-torn", {}, { memory: mem });
        const end = performance.now() + 1500;
        let i = 0;
        while (performance.now() < end) {
          const x = i++ & 1;
          o.s = x ? "${B}" : "${A}";
          o.h = x ? "${LB}" : "${LA}";
          o.n = x ? -2.5e-300 : 1.5;
        }
        self.postMessage("done");
      };
    `;
    const worker = spawn(code);
    let done = false;
    worker.onmessage = () => {
      done = true;
    };
    worker.postMessage(mem.exportBuffers());
    let reads = 0;
    let bad = 0;
    while (!done) {
      for (let i = 0; i < 5000; i++) {
        const s = o.s;
        if (s !== A && s !== B) bad++;
        const h = o.h;
        if (h !== LA && h !== LB) bad++;
        const n = o.n;
        if (n !== 1.5 && n !== -2.5e-300) bad++;
        reads++;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    worker.terminate();
    expect(reads).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  }, 30000);

  test("an ordinary write waits for another thread's withReadLock", async () => {
    const mem = new SharedMemory();
    const o = Shared("seq-readlock", { n: 0 }, { memory: mem });
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(SRC)};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data);
        const o = Shared("seq-readlock", {}, { memory: mem });
        o.withReadLock(() => {
          self.postMessage("locked");
          const end = performance.now() + 300;
          while (performance.now() < end) {}
        });
      };
    `;
    const worker = spawn(code);
    await new Promise<void>((resolve, reject) => {
      worker.onerror = (e) => reject(e);
      worker.onmessage = () => resolve();
      worker.postMessage(mem.exportBuffers());
    });
    const started = performance.now();
    o.n = 7; // must wait until the other thread released its read lock
    const waited = performance.now() - started;
    worker.terminate();
    expect(o.n).toBe(7);
    expect(waited).toBeGreaterThan(150);
    expect(waited).toBeLessThan(5000);
  }, 20000);

  test("a thread's own locks and writes never wait for themselves", () => {
    const saved = getDefaultLockTimeout();
    setDefaultLockTimeout(1500); // a self-deadlock fails fast instead of hanging
    try {
      const mem = new SharedMemory();
      const a = Shared("seq-own-a", { n: 0 }, { memory: mem });
      const b = Shared("seq-own-b", { n: 0 }, { memory: mem });
      // Ordinary write inside the thread's own user-level locks.
      a.withWriteLock((self) => {
        self.n = 1;
        expect(self.n).toBe(1);
      });
      a.withReadLock((self) => {
        expect(self.n).toBe(1);
        self.n = 2;
      });
      expect(a.n).toBe(2);
      // A user-level lock requested from inside an ordinary write of the same
      // key, and reads of the key being written.
      a.update((cur) => {
        expect(a.n).toBe(cur.n);
        a.withWriteLock(() => undefined);
        return { n: cur.n + 1 };
      });
      expect(a.n).toBe(3);
      // A write to another key from inside an update().
      a.update((cur) => {
        b.n = cur.n * 10;
        return { n: cur.n };
      });
      expect(b.n).toBe(30);
    } catch (error) {
      expect(error instanceof LockTimeoutError).toBe(false);
      throw error;
    } finally {
      setDefaultLockTimeout(saved);
    }
  });

  test("a change made by another thread becomes visible to a hot cached read", async () => {
    const mem = new SharedMemory();
    const flag = Shared("seq-visible", { go: 0 }, { memory: mem });
    expect(flag.go).toBe(0); // fill the read cache
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(SRC)};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data);
        const f = Shared("seq-visible", {}, { memory: mem });
        setTimeout(() => { f.go = 1; self.postMessage("written"); }, 100);
      };
    `;
    const worker = spawn(code);
    worker.postMessage(mem.exportBuffers());
    const deadline = performance.now() + 5000;
    let spins = 0;
    // A tight loop of cache hits (plain reads of the version cell).
    while (flag.go === 0 && performance.now() < deadline) {
      for (let i = 0; i < 10000 && flag.go === 0; i++) spins++;
    }
    worker.terminate();
    expect(flag.go).toBe(1);
    expect(spins).toBeGreaterThan(0);
  }, 20000);
});
