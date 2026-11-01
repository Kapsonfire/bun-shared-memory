/**
 * Real-world benchmark runner.
 *
 * Compares three methodologies for serving a "get user" request through an
 * Elysia mini API:
 *
 *   1. shared — reads from shared memory (bun-shared-memory)
 *   2. sqlite — reads live from a SQLite database
 *   3. mysql  — reads live from a MySQL database (Docker)
 *
 * Each methodology is benchmarked sequentially (not concurrently). For each
 * one, 4 workers are spawned; the total request count is split evenly across
 * them and each worker processes its share by calling `app.fetch()` directly
 * (no HTTP server).
 *
 * Run:
 *   docker compose -f bench/real-world/docker-compose.yml up -d   # MySQL
 *   bun bench/real-world/seed.ts                                   # seed DBs
 *   bun bench/real-world/run.ts [requests]                         # benchmark
 */
import { Shared, init } from "../../src/index.ts";
import { SHARED_USER_KEY } from "./api.ts";
import { USER } from "./data.ts";
import type { Methodology } from "./api.ts";

const WORKERS_PER_METHOD = 4;
const DEFAULT_REQUESTS = 100_000;

const totalRequests = Number(process.argv[2] ?? DEFAULT_REQUESTS);

// --- Shared-memory setup ---------------------------------------------------
// Seed the shared user record on the main thread and start the worker
// handshake so shared-memory workers receive the buffers.
await init({ initialSize: 64 * 1024, maxByteLength: 512 * 1024 * 1024 });
Shared(SHARED_USER_KEY, USER);

interface MethodResult {
  methodology: Methodology;
  elapsedMs: number;
  count: number;
}

/** Run one methodology across 4 workers and return the aggregate result. */
async function runMethodology(methodology: Methodology): Promise<MethodResult> {
  const perWorker = Math.floor(totalRequests / WORKERS_PER_METHOD);
  const workers: Worker[] = [];
  const results: Promise<MethodResult>[] = [];

  for (let w = 0; w < WORKERS_PER_METHOD; w++) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workers.push(worker);

    results.push(
      new Promise<MethodResult>((resolve) => {
        worker.onmessage = (e) => {
          const msg = e.data as {
            type: string;
            methodology: Methodology;
            elapsedMs: number;
            count: number;
          };
          if (msg.type === "result") {
            resolve({
              methodology: msg.methodology,
              elapsedMs: msg.elapsedMs,
              count: msg.count,
            });
          }
        };
      }),
    );

    // Each worker gets a distinct starting id so reads spread across rows.
    worker.postMessage({
      type: "bench",
      methodology,
      count: perWorker,
      userId: 1 + w * 10,
    });
  }

  const resultsArr = await Promise.all(results);
  for (const w of workers) w.terminate();

  const totalElapsed = Math.max(...resultsArr.map((r) => r.elapsedMs));
  const totalCount = resultsArr.reduce((s, r) => s + r.count, 0);
  return { methodology, elapsedMs: totalElapsed, count: totalCount };
}

// --- Run all three methodologies sequentially ------------------------------
const order: Methodology[] = ["shared", "sqlite", "mysql"];
const outcomes: MethodResult[] = [];

for (const m of order) {
  process.stdout.write(`Benchmarking ${m.padEnd(7)} ... `);
  const res = await runMethodology(m);
  outcomes.push(res);
  const ops = Math.round(res.count / (res.elapsedMs / 1000));
  console.log(`${ops.toLocaleString()} req/s (${res.elapsedMs.toFixed(0)} ms)`);
}

// --- Report -----------------------------------------------------------------
console.log("\n── Real-world benchmark ────────────────────────────────────");
console.log(`Requests per methodology: ${totalRequests.toLocaleString()}`);
console.log(`Workers per methodology:  ${WORKERS_PER_METHOD}`);
console.log("");
console.log("| Methodology | Requests | Elapsed (ms) | req/s      |");
console.log("|-------------|----------|--------------|------------|");
const table: Record<string, { reqs: number; ms: number; ops: number }> = {};
for (const o of outcomes) {
  const ops = Math.round(o.count / (o.elapsedMs / 1000));
  table[o.methodology] = { reqs: o.count, ms: o.elapsedMs, ops };
  console.log(
    `| ${o.methodology.padEnd(11)} | ${String(o.count).padStart(8)} | ${o.elapsedMs.toFixed(0).padStart(12)} | ${ops.toLocaleString().padStart(10)} |`,
  );
}

// Relative comparison against shared memory (the fastest expected).
const shared = table["shared"];
if (shared) {
  console.log("");
  for (const m of ["sqlite", "mysql"] as const) {
    const t = table[m];
    if (!t) continue;
    const ratio = shared.ops / t.ops;
    console.log(
      `${m.padEnd(7)} is ${ratio.toFixed(1)}× slower than shared memory`,
    );
  }
}
