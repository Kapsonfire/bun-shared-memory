/**
 * Real-world benchmark runner.
 *
 * Compares four methodologies for serving a "get user" request through an
 * Elysia mini API:
 *
 *   1. shared — reads from shared memory (bun-shared-memory)
 *   2. sqlite — reads live from a SQLite database
 *   3. mysql  — reads live from a MySQL database (Docker)
 *   4. redis  — reads live from a Redis database (Docker)
 *
 * Each methodology is benchmarked sequentially (not concurrently). For each
 * one, 4 workers are spawned; the total request count is split evenly across
 * them and each worker processes its share by calling `app.fetch()` directly
 * (no HTTP server).
 *
 * MySQL/Redis are benchmarked over BOTH transports — TCP and Unix socket.
 * The socket run is skipped on macOS/Windows (Docker Desktop cannot expose
 * container Unix sockets), without error.
 *
 * Run:
 *   docker compose -f bench/real-world/docker-compose.yml up -d   # MySQL + Redis
 *   bun bench/real-world/seed.ts                                   # seed DBs
 *   bun bench/real-world/run.ts [requests]                         # benchmark
 */
import { Shared, init } from "../../src/index.ts";
import { SHARED_USER_KEY } from "./api.ts";
import { USER } from "./data.ts";
import type { Methodology, Transport } from "./api.ts";

const WORKERS_PER_METHOD = 4;
const DEFAULT_REQUESTS = 100_000;
/** Measured samples per worker; the worker reports the minimum. */
const SAMPLES_PER_WORKER = 15;
/** Full runs per methodology (each spawns the workers again); min is kept. */
const RUNS_PER_METHOD = 5;

const totalRequests = Number(process.argv[2] ?? DEFAULT_REQUESTS);

/** Whether Unix sockets are usable on this platform (Linux only). */
const SOCKET_SUPPORTED = process.platform === "linux";

// --- Shared-memory setup ---------------------------------------------------
// Seed the shared user record on the main thread and start the worker
// handshake so shared-memory workers receive the buffers.
await init({ initialSize: 64 * 1024, maxByteLength: 512 * 1024 * 1024 });
Shared(SHARED_USER_KEY, USER);

interface MethodResult {
  methodology: Methodology;
  /** Transport used (null for shared/sqlite which have no transport). */
  transport: Transport | null;
  elapsedMs: number;
  count: number;
}

/** Run one methodology across 4 workers and return the aggregate result. */
async function runMethodology(
  methodology: Methodology,
  transport: Transport | null,
): Promise<MethodResult> {
  const perWorker = Math.floor(totalRequests / WORKERS_PER_METHOD);
  const workers: Worker[] = [];
  const results: Promise<MethodResult>[] = [];

  for (let w = 0; w < WORKERS_PER_METHOD; w++) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workers.push(worker);

    results.push(
      new Promise<MethodResult>((resolve, reject) => {
        worker.onmessage = (e) => {
          const msg = e.data as {
            type: string;
            methodology: Methodology;
            elapsedMs: number;
            count: number;
            message?: string;
          };
          if (msg.type === "result") {
            resolve({
              methodology: msg.methodology,
              transport,
              elapsedMs: msg.elapsedMs,
              count: msg.count,
            });
          } else if (msg.type === "error") {
            reject(
              new Error(
                `[${msg.methodology}] worker error: ${msg.message ?? "unknown"}`,
              ),
            );
          }
        };
      }),
    );

    // Each worker gets a distinct starting id so reads spread across rows.
    worker.postMessage({
      type: "bench",
      methodology,
      transport,
      count: perWorker,
      userId: 1 + w * 10,
      samples: SAMPLES_PER_WORKER,
    });
  }

  const resultsArr = await Promise.all(results).catch((err) => {
    for (const w of workers) w.terminate();
    throw err;
  });
  for (const w of workers) w.terminate();

  const totalElapsed = Math.max(...resultsArr.map((r) => r.elapsedMs));
  const totalCount = resultsArr.reduce((s, r) => s + r.count, 0);
  return { methodology, transport, elapsedMs: totalElapsed, count: totalCount };
}

// --- Run all methodologies sequentially ------------------------------------
// shared/sqlite have no transport; mysql/redis run over BOTH tcp and socket
// (socket skipped on non-Linux platforms).
const outcomes: MethodResult[] = [];

async function bench(label: string, m: Methodology, t: Transport | null) {
  process.stdout.write(`Benchmarking ${label.padEnd(16)} ... `);
  // Run several times and keep the fastest. CPU contention can only slow a
  // run down, so the minimum is the best estimate of true throughput.
  let best: MethodResult | null = null;
  for (let r = 0; r < RUNS_PER_METHOD; r++) {
    const res = await runMethodology(m, t);
    if (best === null || res.elapsedMs < best.elapsedMs) best = res;
  }
  outcomes.push(best!);
  const ops = Math.round(best!.count / (best!.elapsedMs / 1000));
  console.log(
    `${ops.toLocaleString()} req/s (${best!.elapsedMs.toFixed(0)} ms)`,
  );
}

await bench("shared", "shared", null);
await bench("sqlite", "sqlite", null);
await bench("mysql (tcp)", "mysql", "tcp");
await bench("redis (tcp)", "redis", "tcp");
if (SOCKET_SUPPORTED) {
  await bench("mysql (socket)", "mysql", "socket");
  await bench("redis (socket)", "redis", "socket");
} else {
  console.log(
    `Skipping mysql/redis (socket): not supported on ${process.platform}`,
  );
}

// --- Report -----------------------------------------------------------------
// Sort by speed (req/s descending) so the fastest methodology is first.
const sorted = [...outcomes].sort(
  (a, b) => b.count / b.elapsedMs - a.count / a.elapsedMs,
);

console.log("\n── Real-world benchmark ────────────────────────────────────");
console.log(`Requests per methodology: ${totalRequests.toLocaleString()}`);
console.log(`Workers per methodology:  ${WORKERS_PER_METHOD}`);
console.log(`Samples per worker:       ${SAMPLES_PER_WORKER} (min kept)`);
console.log(`Runs per methodology:     ${RUNS_PER_METHOD} (min kept)`);
console.log("");
console.log(
  "| Methodology | Transport | Requests | Elapsed (ms) | req/s      |",
);
console.log(
  "|-------------|-----------|----------|--------------|------------|",
);
const table: Record<string, { reqs: number; ms: number; ops: number }> = {};
for (const o of sorted) {
  const ops = Math.round(o.count / (o.elapsedMs / 1000));
  const key = o.transport ? `${o.methodology}:${o.transport}` : o.methodology;
  table[key] = { reqs: o.count, ms: o.elapsedMs, ops };
  const label = o.transport
    ? `${o.methodology} (${o.transport})`
    : o.methodology;
  console.log(
    `| ${label.padEnd(11)} | ${(o.transport ?? "—").padEnd(9)} | ${String(o.count).padStart(8)} | ${o.elapsedMs.toFixed(0).padStart(12)} | ${ops.toLocaleString().padStart(10)} |`,
  );
}

// Relative comparison against shared memory (the fastest expected).
const shared = table["shared"];
if (shared) {
  console.log("");
  for (const key of Object.keys(table)) {
    if (key === "shared") continue;
    const t = table[key];
    if (!t) continue;
    const ratio = shared.ops / t.ops;
    console.log(
      `${key.padEnd(16)} is ${ratio.toFixed(1)}× slower than shared memory`,
    );
  }
}

// --- Write benchlog ---------------------------------------------------------
// Persist the results to benchlogs/<timestamp>-<commit>-real.md so each run
// has its own file (matching the convention of the micro benchmarks, with a
// "-real" suffix to distinguish the real-world benchmark).
const { commit, timestamp } = currentCommit();
const logDir = new URL("../../benchlogs/", import.meta.url);
const logFile = new URL(`${timestamp}-${commit}-real.md`, logDir);

const lines: string[] = [];
lines.push(`# Real-world benchmark ${commit}`);
lines.push("");
lines.push(`Date: ${new Date().toISOString()}`);
lines.push(`Platform: ${process.platform} (${process.arch})`);
lines.push(`Requests per methodology: ${totalRequests}`);
lines.push(`Workers per methodology: ${WORKERS_PER_METHOD}`);
lines.push(`Samples per worker: ${SAMPLES_PER_WORKER} (min kept)`);
lines.push(`Runs per methodology: ${RUNS_PER_METHOD} (min kept)`);
lines.push("");
lines.push("| Methodology | Transport | Requests | Elapsed (ms) | req/s |");
lines.push("|-------------|-----------|----------|--------------|-------|");
for (const o of sorted) {
  const ops = Math.round(o.count / (o.elapsedMs / 1000));
  const label = o.transport
    ? `${o.methodology} (${o.transport})`
    : o.methodology;
  lines.push(
    `| ${label} | ${o.transport ?? "—"} | ${o.count} | ${o.elapsedMs.toFixed(0)} | ${ops} |`,
  );
}
lines.push("");
lines.push("## vs. shared memory");
if (shared) {
  for (const key of Object.keys(table)) {
    if (key === "shared") continue;
    const t = table[key];
    if (!t) continue;
    lines.push(`- ${key}: ${(shared.ops / t.ops).toFixed(1)}× slower`);
  }
}

await Bun.write(logFile, lines.join("\n") + "\n");
console.log(
  `\nWrote benchmark log to benchlogs/${timestamp}-${commit}-real.md`,
);

/**
 * Resolve the current git commit hash (short form) and its committer date as
 * a Unix timestamp, or "unknown"/0 if git is unavailable.
 */
function currentCommit(): { commit: string; timestamp: number } {
  try {
    const hashOut = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--short", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const commit = hashOut.stdout.toString().trim() || "unknown";
    const tsOut = Bun.spawnSync({
      cmd: ["git", "show", "-s", "--format=%ct", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const timestamp = Number(tsOut.stdout.toString().trim()) || 0;
    return { commit, timestamp };
  } catch {
    return { commit: "unknown", timestamp: 0 };
  }
}
