/**
 * Multi-worker write contention benchmark.
 *
 * Several workers write concurrently for a fixed time and the total throughput
 * is reported. Two scenarios:
 *
 *  - "own key":  every worker writes to its own key (no logical conflict) —
 *                measures how well independent writers scale.
 *  - "same key": every worker writes to one shared key — the worst case, all
 *                writers must be serialized.
 *
 * Run: `bun run bench:contention [workers] [spacing]`, e.g.
 * `bun bench/contention.ts 1,2,4,8 16`. `spacing` is the number of filler keys
 * between benchmark keys (0 = adjacent, which shows false sharing).
 */
import { SharedMemory, Shared } from "../src/index.ts";

const DURATION_MS = 1500;
const SPACING = Number.parseInt(process.argv[3] ?? "16", 10);
const counts = (process.argv[2] ?? "1,2,4,8")
  .split(",")
  .map((n) => Number.parseInt(n, 10));

const workerCode = `
  import { SharedMemory, Shared } from ${JSON.stringify(
    new URL("../src/index.ts", import.meta.url).href,
  )};
  self.onmessage = (e) => {
    const { buffers, key, durationMs, start } = e.data;
    const mem = SharedMemory.fromBuffers(buffers);
    const o = Shared(key, { n: 0 }, { memory: mem });
    self.postMessage("ready");
    const go = new Int32Array(start);
    Atomics.wait(go, 0, 0); // released by the main thread
    let ops = 0;
    const end = performance.now() + durationMs;
    while (performance.now() < end) {
      for (let i = 0; i < 1000; i++) o.n = i;
      ops += 1000;
    }
    self.postMessage({ ops });
  };
`;

async function run(workers: number, sameKey: boolean): Promise<number> {
  const mem = new SharedMemory();
  // `SPACING` filler keys between the benchmark keys keep their version cells
  // and data blocks on different cache lines (0 = adjacent, maximal false
  // sharing between the writers).
  for (let i = 0; i < workers; i++) {
    Shared(`c-${i}`, { n: 0 }, { memory: mem });
    for (let f = 0; f < SPACING; f++) {
      Shared(`filler-${i}-${f}`, { n: 0 }, { memory: mem });
    }
  }
  Shared("c-shared", { n: 0 }, { memory: mem });
  const buffers = mem.exportBuffers();
  const start = new SharedArrayBuffer(4);
  const url = new URL(
    "data:text/javascript," + encodeURIComponent(workerCode),
    import.meta.url,
  );
  const pool: Worker[] = [];
  let ready = 0;
  const allReady = new Promise<void>((resolve) => {
    for (let i = 0; i < workers; i++) {
      const w = new Worker(url, { type: "module" });
      pool.push(w);
      w.onmessage = () => {
        if (++ready === workers) resolve();
      };
      w.postMessage({
        buffers,
        start,
        durationMs: DURATION_MS,
        key: sameKey ? "c-shared" : `c-${i}`,
      });
    }
  });
  await allReady;
  const results = pool.map(
    (w) =>
      new Promise<number>((resolve) => {
        w.onmessage = (e) => resolve((e.data as { ops: number }).ops);
      }),
  );
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0);
  const ops = (await Promise.all(results)).reduce((a, b) => a + b, 0);
  pool.forEach((w) => w.terminate());
  mem.dispose();
  return ops / (DURATION_MS / 1000);
}

console.log("workers | own key (M ops/s) | same key (M ops/s)");
console.log("--------|-------------------|-------------------");
for (const n of counts) {
  const own = await run(n, false);
  const same = await run(n, true);
  console.log(
    `${String(n).padStart(7)} | ${(own / 1e6).toFixed(2).padStart(17)} | ${(same / 1e6).toFixed(2).padStart(18)}`,
  );
}
