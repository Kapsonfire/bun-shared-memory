/**
 * Multi-worker read scaling benchmark.
 *
 * Several workers read one property in a loop for a fixed time (cache hits) and
 * the total throughput is reported. Two scenarios:
 *
 *  - "own key":  every worker reads its own key.
 *  - "same key": every worker reads the same key (the typical "many workers
 *                read one shared config/data object" case).
 *
 * Run: `bun run bench:readscale [workers]`, e.g. `bun bench/readscale.ts 1,2,4,8`.
 */
import { SharedMemory, Shared } from "../src/index.ts";

const DURATION_MS = 1200;
const counts = (process.argv[2] ?? "1,2,4,8")
  .split(",")
  .map((n) => Number.parseInt(n, 10));

const workerCode = `
  import { SharedMemory, Shared } from ${JSON.stringify(
    new URL("../src/index.ts", import.meta.url).href,
  )};
  self.onmessage = (e) => {
    const { buffers, key, start, durationMs } = e.data;
    const mem = SharedMemory.fromBuffers(buffers);
    const o = Shared(key, {}, { memory: mem });
    let sum = 0;
    for (let i = 0; i < 100000; i++) sum += o.n; // warm up
    self.postMessage("ready");
    Atomics.wait(new Int32Array(start), 0, 0);
    let ops = 0;
    const end = performance.now() + durationMs;
    while (performance.now() < end) {
      for (let i = 0; i < 10000; i++) sum += o.n;
      ops += 10000;
    }
    self.postMessage({ ops, sum });
  };
`;

async function run(workers: number, sameKey: boolean): Promise<number> {
  const mem = new SharedMemory();
  // Filler keys keep each worker's key on its own cache line.
  for (let i = 0; i < workers; i++) {
    Shared(`r${i}`, { n: 1 }, { memory: mem });
    for (let f = 0; f < 16; f++)
      Shared(`f${i}-${f}`, { n: 0 }, { memory: mem });
  }
  Shared("shared", { n: 1 }, { memory: mem });
  const buffers = mem.exportBuffers();
  const start = new SharedArrayBuffer(4);
  const url = new URL(
    "data:text/javascript," + encodeURIComponent(workerCode),
    import.meta.url,
  );
  const pool: Worker[] = [];
  let ready = 0;
  await new Promise<void>((resolve) => {
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
        key: sameKey ? "shared" : `r${i}`,
      });
    }
  });
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

console.log("workers | own key (M reads/s) | same key (M reads/s)");
console.log("--------|---------------------|---------------------");
for (const n of counts) {
  const own = await run(n, false);
  const same = await run(n, true);
  console.log(
    `${String(n).padStart(7)} | ${(own / 1e6).toFixed(0).padStart(19)} | ${(same / 1e6).toFixed(0).padStart(20)}`,
  );
}
process.exit(0);
