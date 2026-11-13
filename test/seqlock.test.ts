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

/**
 * Plain writes inside the thread's own `withWriteLock` take the fast path
 * under the lock's bit (no bit of their own, one version bump each). The
 * thread's own reads must see them at once, other threads only all of them.
 */
describe("plain writes inside the thread's own write lock", () => {
  test("own reads see each write; nesting, re-entry and exceptions", () => {
    const saved = getDefaultLockTimeout();
    setDefaultLockTimeout(1500); // a stuck bit fails fast instead of hanging
    try {
      const mem = new SharedMemory();
      const o = Shared(
        "own-lock",
        { n: 0, s: "a", b: false, sub: { x: 0 }, arr: [0, 0] },
        { memory: mem },
      );
      const p = Shared("own-lock-p", { m: 0 }, { memory: mem });
      const arr = Shared("own-lock-arr", [0, 0, 0], { memory: mem });
      expect(o.n).toBe(0); // fill the caches
      expect(o.sub.x).toBe(0);

      o.withWriteLock((self) => {
        for (let i = 1; i <= 3; i++) {
          self.n = i;
          expect(self.n).toBe(i);
          self.s = `s${i}`;
          expect(self.s).toBe(`s${i}`);
          self.b = i % 2 === 1;
          expect(self.b).toBe(i % 2 === 1);
          self.sub.x = i * 10;
          expect(self.sub.x).toBe(i * 10);
          self.arr[1] = i;
          expect(self.arr[1]).toBe(i);
        }
        // Another key's lock inside, and a write to this key while it is held.
        p.withWriteLock((q) => {
          q.m = 5;
          self.n = 4;
          expect(q.m).toBe(5);
          expect(self.n).toBe(4);
        });
        self.n = 5; // after the inner lock: own lock again
        // Re-entry on the same key.
        o.withWriteLock((again) => {
          again.n = 6;
        });
        expect(self.n).toBe(6);
        self.n = 7;
      });
      expect(o.read()).toEqual({
        n: 7,
        s: "s3",
        b: true,
        sub: { x: 30 },
        arr: [0, 3],
      });
      expect(p.m).toBe(5);

      // Top-level array and primitive refs inside their locks.
      arr.withWriteLock((a) => {
        a[0] = 1;
        a[2] = 3;
        expect(a[0]).toBe(1);
      });
      expect(arr.read()).toEqual([1, 0, 3]);

      // An exception inside the callback releases the lock and its state.
      expect(() =>
        o.withWriteLock((self) => {
          self.n = 8;
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(o.n).toBe(8);
      o.n = 9; // plain write after the lock: its own bit again
      expect(o.n).toBe(9);
      o.withReadLock((self) => {
        expect(self.n).toBe(9);
      });
    } finally {
      setDefaultLockTimeout(saved);
    }
  });

  test("another thread sees the writes of one lock all or none", async () => {
    const mem = new SharedMemory();
    const o = Shared(
      "own-lock-atomic",
      { a: 0, b: 0, s: "0", sub: { c: 0 } },
      { memory: mem },
    );
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(SRC)};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data);
        const o = Shared("own-lock-atomic", {}, { memory: mem });
        const end = performance.now() + 1500;
        let reads = 0;
        let bad = 0;
        let last = 0;
        while (performance.now() < end) {
          const v = o.withReadLock((s) => [s.a, s.b, s.s, s.sub.c]);
          if (v[0] !== v[1] || v[2] !== String(v[0]) || v[3] !== v[0]) bad++;
          if (v[0] < last) bad++;
          last = v[0];
          reads++;
        }
        self.postMessage({ reads, bad });
      };
    `;
    const worker = spawn(code);
    let result: { reads: number; bad: number } | undefined;
    worker.onmessage = (e) => {
      result = e.data;
    };
    worker.postMessage(mem.exportBuffers());
    let i = 0;
    while (result === undefined) {
      for (let k = 0; k < 2000; k++) {
        i++;
        o.withWriteLock((self) => {
          self.a = i;
          self.s = String(i);
          self.sub.c = i;
          self.b = i;
        });
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    worker.terminate();
    expect(result.reads).toBeGreaterThan(1000);
    expect(result.bad).toBe(0);
    expect(o.read()).toEqual({ a: i, b: i, s: String(i), sub: { c: i } });
  }, 30000);
});

describe("nested user-level locks on one key", () => {
  test("every combination works and leaves no lock bit behind", () => {
    const saved = getDefaultLockTimeout();
    setDefaultLockTimeout(1000); // waiting for itself fails fast
    try {
      const mem = new SharedMemory();
      const o = Shared("nested-locks", { n: 0 }, { memory: mem });
      const bits = () =>
        Atomics.load(
          mem.versionView,
          mem.getVersionCellIndex(mem.lookupIndex("nested-locks")!),
        ) & 3;
      o.withWriteLock(() => o.withWriteLock((s) => (s.n = 1)));
      expect(bits()).toBe(0);
      o.withReadLock(() => o.withReadLock((s) => s.n));
      expect(bits()).toBe(0);
      expect(o.withWriteLock(() => o.withReadLock((s) => s.n))).toBe(1);
      expect(bits()).toBe(0);
      o.withReadLock(() => o.withWriteLock((s) => (s.n = 2)));
      expect(bits()).toBe(0);
      expect(o.n).toBe(2);
      // Three levels, and an exception from the innermost.
      expect(() =>
        o.withWriteLock(() =>
          o.withReadLock(() =>
            o.withWriteLock(() => {
              throw new Error("inner");
            }),
          ),
        ),
      ).toThrow("inner");
      expect(bits()).toBe(0);
      o.n = 3;
      expect(o.n).toBe(3);
    } finally {
      setDefaultLockTimeout(saved);
    }
  });
});

describe("setDefaultLockTimeout", () => {
  test("rejects zero, negative and NaN timeouts and keeps the old one", () => {
    const saved = getDefaultLockTimeout();
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => setDefaultLockTimeout(bad)).toThrow(RangeError);
    }
    expect(getDefaultLockTimeout()).toBe(saved);
    setDefaultLockTimeout(Infinity); // allowed: wait forever
    expect(getDefaultLockTimeout()).toBe(Infinity);
    setDefaultLockTimeout(saved);
  });
});
