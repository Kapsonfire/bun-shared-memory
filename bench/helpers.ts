import { Shared } from "../src/index.ts";

interface BenchResult {
  name: string;
  nativeOps: number;
  sharedOps: number;
  ratio: number;
  kind: "read" | "array-read" | "write" | "array-write";
}

const results: BenchResult[] = [];

/** Whether the one-time CPU warmup has already run (see benchPair). */
let warmedUp = false;

/**
 * Classify a benchmark name into a summary category.
 *
 * - "read"        — primitive/object reads
 * - "array-read"  — array index reads (top-level arrays or object array props)
 * - "array-write" — array mutations: index writes, push, pop (on top-level
 *                   arrays or object array properties)
 * - "write"       — everything else that writes (primitives, object props)
 */
function classify(name: string): BenchResult["kind"] {
  const isArray = /\[\]|array/i.test(name);
  if (/read/i.test(name)) return isArray ? "array-read" : "read";
  if (isArray && /write|push|pop/i.test(name)) return "array-write";
  return "write";
}

/**
 * How benchPair behaves, chosen by the environment:
 *
 * - `BENCH_LIST=1`: only print the case names (as `BENCHCASES <json>`).
 * - `BENCH_CASE=<name>`: run just that case and print `BENCHRESULT <json>`.
 *   `bench.ts` starts one such process per case, so no case sees the JIT type
 *   feedback of an earlier one (a single process made results depend on the
 *   order of the cases).
 * - neither: run every case in this process (`bun benc./index.ts`).
 */
const listOnly = process.env.BENCH_LIST === "1";
const onlyCase = process.env.BENCH_CASE;
const listed: string[] = [];

/** Print the collected case names when listing (called by benc./index.ts). */
export function finishListing(): void {
  if (listOnly) console.log(`BENCHCASES ${JSON.stringify(listed)}`);
}

/**
 * Run a shared-vs-native benchmark for a single operation.
 *
 * `native` and `shared` are the two functions to compare. Each is invoked
 * `iterations` times per batch. Results are reported as ops/sec.
 */
export function benchPair(
  name: string,
  native: () => unknown,
  shared: () => unknown,
  iterations = 1_000_000,
): void {
  if (listOnly) {
    listed.push(name);
    return;
  }
  if (onlyCase !== undefined && name !== onlyCase) return;

  // The first measure() loop after process start gets a one-time JIT
  // constant-folding boost (~11 Mrd ops/s instead of ~7 Mrd for a native
  // read). Consume it with real measure() passes on a constant closure, so the
  // measured case does not get it. A plain CPU busy-loop does NOT trigger it.
  if (!warmedUp) {
    warmedUp = true;
    const warmConst = 0;
    measure(() => warmConst, 1_000_000, 300);
    measure(() => warmConst, 1_000_000, 300);
  }

  // Warm up both paths so JIT compilation doesn't skew the comparison.
  // Use the same iteration count so growing operations (e.g. array push)
  // don't exhaust the append-only buffers during warmup.
  const warmup = Math.min(iterations, 10_000);
  for (let i = 0; i < warmup; i++) {
    native();
    shared();
  }

  // Warm up the exact native closure (it also gets a one-time boost on its
  // first measure() loop) and let the shared path reach its optimized tier.
  measure(native, iterations, 500);
  measure(shared, iterations, 300);

  const sharedOps = measure(shared, iterations);
  const nativeOps = measure(native, iterations);

  if (onlyCase !== undefined) {
    console.log(
      `BENCHRESULT ${JSON.stringify({ name, nativeOps, sharedOps })}`,
    );
    return;
  }
  recordResult(name, nativeOps, sharedOps);
}

/** Store and print one result (the orchestrator calls this per case). */
export function recordResult(
  name: string,
  nativeOps: number,
  sharedOps: number,
): void {
  const ratio = nativeOps / sharedOps;
  const slower =
    ratio >= 1
      ? `${ratio.toFixed(2)}× slower`
      : `${(1 / ratio).toFixed(2)}× faster`;

  results.push({ name, nativeOps, sharedOps, ratio, kind: classify(name) });

  console.log(
    `${name.padEnd(34)} native ${String(nativeOps).padStart(12)} ops/s | shared ${String(sharedOps).padStart(12)} ops/s | ${slower}`,
  );
}

/** Print a summary separating reads, array reads, writes, and array writes. */
export async function printSummary(): Promise<void> {
  const reads = results.filter((r) => r.kind === "read");
  const arrayReads = results.filter((r) => r.kind === "array-read");
  const writes = results.filter((r) => r.kind === "write");
  const arrayWrites = results.filter((r) => r.kind === "array-write");

  const avg = (rs: BenchResult[]) =>
    rs.length === 0 ? 0 : rs.reduce((sum, r) => sum + r.ratio, 0) / rs.length;

  const fmt = (rs: BenchResult[]) =>
    rs.length === 0
      ? "n/a"
      : `${avg(rs).toFixed(1)}× slower (min ${Math.min(...rs.map((r) => r.ratio)).toFixed(1)}×, max ${Math.max(...rs.map((r) => r.ratio)).toFixed(1)}×)`;

  console.log("\n── Summary ──────────────────────────────────────────────");
  console.log(`Reads        (${reads.length}):  ${fmt(reads)}`);
  console.log(`Array reads  (${arrayReads.length}):  ${fmt(arrayReads)}`);
  console.log(`Writes       (${writes.length}): ${fmt(writes)}`);
  console.log(`Array writes (${arrayWrites.length}): ${fmt(arrayWrites)}`);

  await writeLogFile({ reads, arrayReads, writes, arrayWrites, fmt });
}

/**
 * Write the full benchmark results to
 * `benchlogs/<unix-timestamp>-<commit-hash>.md` so each run has its own file
 * named after the commit it was measured on. The timestamp prefix (the
 * commit's committer date) makes the files sortable chronologically.
 */
async function writeLogFile(groups: {
  reads: BenchResult[];
  arrayReads: BenchResult[];
  writes: BenchResult[];
  arrayWrites: BenchResult[];
  fmt: (rs: BenchResult[]) => string;
}): Promise<void> {
  const { reads, arrayReads, writes, arrayWrites, fmt } = groups;
  const { commit, timestamp } = currentCommit();
  const dir = new URL("../benchlogs/", import.meta.url);
  const file = new URL(`${timestamp}-${commit}.md`, dir);

  const lines: string[] = [];
  lines.push(`# Benchmark ${commit}`);
  lines.push("");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Name | Native ops/s | Shared ops/s | Ratio |");
  lines.push("|------|--------------|--------------|-------|");
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${r.nativeOps} | ${r.sharedOps} | ${r.ratio.toFixed(2)}× |`,
    );
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Reads: ${fmt(reads)}`);
  lines.push(`- Array reads: ${fmt(arrayReads)}`);
  lines.push(`- Writes: ${fmt(writes)}`);
  lines.push(`- Array writes: ${fmt(arrayWrites)}`);

  await Bun.write(file, lines.join("\n") + "\n");
  console.log(`\nWrote benchmark log to benchlogs/${timestamp}-${commit}.md`);
}

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

/** Measure ops/sec for `fn` over a fixed wall-clock duration. */
function measure(
  fn: () => unknown,
  iterations: number,
  minDurationMs = 1_000,
): number {
  // Measure a fixed wall-clock duration (1s) rather than a fixed iteration
  // count. A fixed count is unreliable for very fast ops (e.g. native reads
  // at hundreds of millions of ops/s finish in a few ms), which makes the
  // measurement dominated by background noise. Running for a fixed duration
  // averages out that noise. 1 s is enough: 5 fresh processes per case showed the
  // same spread at 5 s, 1 s and 0.5 s (the run-to-run noise of the process, about
  // 3 %, does not shrink with a longer measurement). `iterations` is used only to size the batch.
  const batch = Math.max(1, Math.floor(iterations / 10));
  let total = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    for (let i = 0; i < batch; i++) fn();
    total += batch;
    elapsed = performance.now() - start;
  } while (elapsed < minDurationMs);
  return Math.round(total / (elapsed / 1000));
}

/** A unique key per benchmark run, so runs don't collide in the registry. */
let keyCounter = 0;
export function nextKey(prefix: string): string {
  return `${prefix}-${keyCounter++}`;
}
