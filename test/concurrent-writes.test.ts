import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

/**
 * Writers in several workers hit the same shared values at the same time while
 * the main thread reads. The per-key write caches (offsets, array refs, types)
 * are kept in each worker and invalidated without a signal in some cases, so
 * this checks results that only hold if no worker acts on stale cached state:
 * nothing lost, no torn value, no bounds error for an index another worker
 * just made valid.
 */

const WORKERS = 4;

type Scenario = "slots" | "samestr" | "late" | "mix";

/** What one worker does; runs inside the worker (no imports, no closures). */
function work(scenario: Scenario, w: number, W: number, n: number, ref: any) {
  if (scenario === "slots") {
    for (let c = 1; c <= n; c++) {
      ref[w] = c;
      ref[w + W] = c % 3 === 0 ? true : c % 3 === 1 ? c : `s${c}`;
    }
  } else if (scenario === "samestr") {
    for (let c = 1; c <= n; c++) ref.write(`${w}:${c}`);
  } else if (scenario === "late") {
    // Write to the index this very push created while the others keep pushing.
    for (let c = 0; c < n; c++) {
      const len = ref.push(w * 1e6 + c);
      ref[len - 1] = w * 1e6 + c + 0.5;
    }
  } else {
    // Own slot written while the others' pushes grow (and move) the array.
    for (let c = 1; c <= n; c++) {
      ref[w] = c;
      if (c % 4 === 0) ref.push(w * 1e6 + c / 4);
    }
  }
}

async function run(
  scenario: Scenario,
  initial: unknown,
  n: number,
  /** Called repeatedly on the main thread while the workers run. */
  observe: (ref: any, fail: (m: string) => void) => void,
): Promise<{ ref: any; problems: string[]; dispose: () => void }> {
  const mem = new SharedMemory({
    initialSize: 1 << 16,
    maxByteLength: 1 << 26,
  });
  const key = `cw-${scenario}`;
  const ref: any = Shared(key, initial, { memory: mem, arrayCapacity: 8 });
  const code = `
    import { Shared, SharedMemory } from ${JSON.stringify(
      new URL("../src/index.ts", import.meta.url).href,
    )};
    const work = ${work.toString()};
    self.onmessage = (e) => {
      const d = e.data;
      const ref = Shared(d.key, undefined, {
        memory: SharedMemory.fromBuffers(d.buffers),
      });
      self.postMessage("ready");
      Atomics.wait(new Int32Array(d.start), 0, 0);
      work(d.scenario, d.w, d.W, d.n, ref);
      self.postMessage("done");
    };`;
  const url = new URL(
    "data:text/javascript," + encodeURIComponent(code),
    import.meta.url,
  );
  const start = new SharedArrayBuffer(4);
  const problems: string[] = [];
  const fail = (m: string) => {
    if (problems.length < 5) problems.push(m);
  };
  const pool: Worker[] = [];
  let ready = 0;
  await new Promise<void>((resolve, reject) => {
    for (let w = 0; w < WORKERS; w++) {
      const wk = new Worker(url, { type: "module" });
      pool.push(wk);
      wk.onerror = (e) => reject(new Error(e.message));
      wk.onmessage = () => {
        if (++ready === WORKERS) resolve();
      };
      wk.postMessage({
        buffers: mem.exportBuffers(),
        key,
        start,
        scenario,
        w,
        W: WORKERS,
        n,
      });
    }
  });
  let done = 0;
  const finished = new Promise<void>((resolve) => {
    for (const wk of pool) {
      wk.onmessage = () => {
        if (++done === WORKERS) resolve();
      };
      wk.onerror = (e) => {
        fail(`worker error: ${String(e.message).slice(0, 120)}`);
        if (++done === WORKERS) resolve();
      };
    }
  });
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0);
  let over = false;
  void finished.then(() => (over = true));
  while (!over) {
    for (let i = 0; i < 100; i++) observe(ref, fail);
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    ref,
    problems,
    dispose: () => {
      for (const wk of pool) wk.terminate();
      mem.dispose();
    },
  };
}

describe("concurrent writers", () => {
  test("disjoint slots of mixed types: nothing lost, reads never go back", async () => {
    const n = 20000;
    const last = new Array<number>(WORKERS).fill(0);
    const r = await run(
      "slots",
      Array.from({ length: 2 * WORKERS }, () => 0),
      n,
      (ref, fail) => {
        const a = ref.read();
        for (let w = 0; w < WORKERS; w++) {
          const v = a[w];
          if (!Number.isInteger(v) || v < last[w]! || v > n) {
            fail(`slot ${w} read ${v} after ${last[w]}`);
          } else last[w] = v;
          const t = a[w + WORKERS];
          const ok =
            t === 0 ||
            t === true ||
            (typeof t === "number" && Number.isInteger(t) && t >= 1) ||
            (typeof t === "string" && /^s\d+$/.test(t));
          if (!ok) fail(`slot ${w + WORKERS} read ${String(t)}`);
        }
      },
    );
    const fin = r.ref.read();
    r.dispose();
    expect(r.problems).toEqual([]);
    const lastTyped = n % 3 === 0 ? true : n % 3 === 1 ? n : `s${n}`;
    for (let w = 0; w < WORKERS; w++) {
      expect(fin[w]).toBe(n);
      expect(fin[w + WORKERS]).toBe(lastTyped);
    }
  });

  test("one key written by every worker: no torn string", async () => {
    const n = 20000;
    const r = await run("samestr", "0:0", n, (ref, fail) => {
      const v = ref.read();
      const m = /^(\d+):(\d+)$/.exec(v);
      if (!m || Number(m[1]) >= WORKERS || Number(m[2]) > n) {
        fail(`read ${String(v)}`);
      }
    });
    r.dispose();
    expect(r.problems).toEqual([]);
  });

  test("an index made valid by a push is writable at once, while others push", async () => {
    const n = 1500;
    const r = await run("late", [0], n, () => {});
    const fin: number[] = r.ref.read();
    r.dispose();
    expect(r.problems).toEqual([]);
    expect(fin.length).toBe(1 + WORKERS * n);
    for (let w = 0; w < WORKERS; w++) {
      const mine = fin.filter((x) => Math.floor(x / 1e6) === w && x !== 0);
      expect(mine.length).toBe(n);
      mine.forEach((x, i) => expect(x % 1e6).toBe(i + 0.5));
    }
  });

  test("own slots keep landing while the others' pushes move the array", async () => {
    const n = 8000;
    const r = await run(
      "mix",
      Array.from({ length: WORKERS }, () => 0),
      n,
      () => {},
    );
    const fin: number[] = r.ref.read();
    r.dispose();
    expect(r.problems).toEqual([]);
    for (let w = 0; w < WORKERS; w++) expect(fin[w]).toBe(n);
    const pushed = fin.slice(WORKERS);
    expect(pushed.length).toBe(WORKERS * (n / 4));
    for (let w = 0; w < WORKERS; w++) {
      const mine = pushed.filter((x) => Math.floor(x / 1e6) === w);
      mine.forEach((x, i) => expect(x % 1e6).toBe(i + 1));
    }
  });
});
