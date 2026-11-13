import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

/**
 * Workers rewrite their values in every way at once (whole writes that store
 * new nested blocks and arrays, nested writes, index writes, pushes, all inside
 * `withWriteLock`), while the main thread reads them under `withReadLock` and
 * runs in-place defragmentations in between. Each value carries an invariant
 * every write keeps, so a read that sees a stale cache, a half-done write or
 * data the compaction moved wrongly breaks it.
 */

const SRC = JSON.stringify(new URL("../src/index.ts", import.meta.url).href);

/** Runs in a worker: keep `p.c === n`, `p.s === tag(n)`, `t[0] === n`. */
function churn(w: number, n: number, o: any) {
  const tag = (c: number) => `${w}:${c}:` + String(w).repeat(20);
  for (let c = 1; c <= n; c++) {
    const k = c % 4;
    if (k === 0) o.write({ p: { s: tag(c), c }, t: [c, c, c], n: c });
    else if (k === 1)
      o.withWriteLock((self: any) => {
        self.p.s = tag(c);
        self.p.c = c;
        self.t[0] = c;
        self.n = c;
      });
    else if (k === 2)
      o.withWriteLock((self: any) => {
        self.p = { s: tag(c), c };
        self.t[0] = c;
        self.n = c;
      });
    else
      o.withWriteLock((self: any) => {
        self.t.push(c);
        self.t[0] = c;
        self.p.c = c;
        self.p.s = tag(c);
        self.n = c;
      });
  }
}

/** Runs in a worker: plain whole writes, `b` always derived from `a`. */
function plain(_w: number, n: number, o: any) {
  for (let c = 1; c <= n; c++) o.write({ a: c, b: `x${c}` });
}

async function startWorkers(
  mem: SharedMemory,
  keys: string[],
  body: (w: number, n: number, o: any) => void,
  n: number,
  fail: (m: string) => void,
): Promise<{ finished: Promise<void>; stop: () => void }> {
  const code = `
    import { Shared, SharedMemory } from ${SRC};
    const body = ${body.toString()};
    self.onmessage = (e) => {
      const d = e.data;
      const o = Shared(d.key, undefined, {
        memory: SharedMemory.fromBuffers(d.buffers),
      });
      self.postMessage("ready");
      Atomics.wait(new Int32Array(d.start), 0, 0);
      body(d.w, d.n, o);
      self.postMessage("done");
    };`;
  const url = new URL(
    "data:text/javascript," + encodeURIComponent(code),
    import.meta.url,
  );
  const start = new SharedArrayBuffer(4);
  const pool: Worker[] = [];
  let ready = 0;
  await new Promise<void>((resolve, reject) => {
    keys.forEach((key, w) => {
      const wk = new Worker(url, { type: "module" });
      pool.push(wk);
      wk.onerror = (e) => reject(new Error(e.message));
      wk.onmessage = () => {
        if (++ready === keys.length) resolve();
      };
      wk.postMessage({ buffers: mem.exportBuffers(), key, start, w, n });
    });
  });
  let done = 0;
  const finished = new Promise<void>((resolve) => {
    for (const wk of pool) {
      wk.onmessage = () => {
        if (++done === pool.length) resolve();
      };
      wk.onerror = (e) => {
        fail(`worker error: ${String(e.message).split("\n")[0]}`);
        if (++done === pool.length) resolve();
      };
    }
  });
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0);
  return { finished, stop: () => pool.forEach((wk) => wk.terminate()) };
}

describe("concurrency with locks and defragmentation", () => {
  test("defragmentation while workers rewrite values, nested objects and arrays", async () => {
    const W = 4;
    const n = 6000;
    const mem = new SharedMemory({
      initialSize: 1 << 16,
      maxByteLength: 1 << 27,
    });
    const keys = Array.from({ length: W }, (_, w) => `churn-${w}`);
    const refs: any[] = keys.map((key, w) =>
      Shared(
        key,
        {
          p: { s: `${w}:0:` + String(w).repeat(20), c: 0 },
          t: [0, 0, 0],
          n: 0,
        },
        { memory: mem },
      ),
    );
    const problems: string[] = [];
    const fail = (m: string) => {
      if (problems.length < 5) problems.push(m);
    };
    const check = (w: number, v: any, how: string) => {
      const c = v.n;
      if (
        v.p.c !== c ||
        v.p.s !== `${w}:${c}:` + String(w).repeat(20) ||
        v.t[0] !== c
      ) {
        fail(`${how} churn-${w}: ${JSON.stringify(v).slice(0, 120)}`);
      }
    };
    const { finished, stop } = await startWorkers(mem, keys, churn, n, fail);
    let over = false;
    void finished.then(() => (over = true));
    let defrags = 0;
    while (!over) {
      for (let w = 0; w < W; w++) {
        refs[w].withReadLock((self: any) =>
          check(
            w,
            { n: self.n, p: { c: self.p.c, s: self.p.s }, t: [self.t[0]] },
            "props",
          ),
        );
        refs[w].withReadLock((self: any) => check(w, self.read(), "read()"));
      }
      mem.reclaimInPlace();
      defrags++;
      await new Promise((r) => setTimeout(r, 0));
    }
    const finals = refs.map((ref) => ref.read());
    stop();
    mem.dispose();
    // Problems first (a worker error, a torn read): they explain a final
    // value that falls short, which would otherwise hide them.
    expect(problems).toEqual([]);
    finals.forEach((v, w) => {
      expect(v.n).toBe(n);
      check(w, v, "final");
    });
    expect(problems).toEqual([]);
    expect(defrags).toBeGreaterThan(1);
  });

  test("a read inside withReadLock does not deadlock with another worker's writes", async () => {
    // The writer used to take the key's stripe and then wait for the read
    // lock bit, while the reader, holding that bit, waited for the stripe
    // (a read that misses its cache takes it).
    const mem = new SharedMemory();
    const ref: any = Shared("rl-1", { a: 0, b: "x0" }, { memory: mem });
    const problems: string[] = [];
    const { finished, stop } = await startWorkers(
      mem,
      ["rl-1"],
      plain,
      30000,
      (m) => problems.push(m),
    );
    let over = false;
    void finished.then(() => (over = true));
    while (!over) {
      for (let i = 0; i < 50; i++) {
        const v = ref.withReadLock((self: any) => self.read());
        if (v.b !== `x${v.a}`) problems.push(`read ${JSON.stringify(v)}`);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    stop();
    mem.dispose();
    expect(problems).toEqual([]);
  });
});
