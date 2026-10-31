import { Shared } from "../src/index.ts";

interface BenchResult {
  name: string;
  nativeOps: number;
  sharedOps: number;
  ratio: number;
  kind: "read" | "array-read" | "write" | "array-write";
}

const results: BenchResult[] = [];

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
 * Run a shared-vs-native benchmark for a single operation.
 *
 * `native` and `shared` are the two functions to compare. Each is invoked
 * `iterations` times per sample. Results are reported as ops/sec.
 */
export function benchPair(
  name: string,
  native: () => unknown,
  shared: () => unknown,
  iterations = 1_000_000,
): void {
  // Warm up both paths so JIT compilation doesn't skew the comparison.
  // Use the same iteration count so growing operations (e.g. array push)
  // don't exhaust the append-only buffers during warmup.
  const warmup = Math.min(iterations, 10_000);
  for (let i = 0; i < warmup; i++) {
    native();
    shared();
  }

  const nativeOps = measure(native, iterations);
  const sharedOps = measure(shared, iterations);

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
 * Write the full benchmark results to `benchlogs/<commit-hash>.md` so each
 * run has its own file named after the commit it was measured on.
 */
async function writeLogFile(groups: {
  reads: BenchResult[];
  arrayReads: BenchResult[];
  writes: BenchResult[];
  arrayWrites: BenchResult[];
  fmt: (rs: BenchResult[]) => string;
}): Promise<void> {
  const { reads, arrayReads, writes, arrayWrites, fmt } = groups;
  const commit = currentCommit();
  const dir = new URL("../benchlogs/", import.meta.url);
  const file = new URL(`${commit}.md`, dir);

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
  console.log(`\nWrote benchmark log to benchlogs/${commit}.md`);
}

/** Resolve the current git commit hash (short form), or "unknown". */
function currentCommit(): string {
  try {
    const out = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--short", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const hash = out.stdout.toString().trim();
    return hash || "unknown";
  } catch {
    return "unknown";
  }
}

/** Measure ops/sec for `fn` over a fixed wall-clock duration. */
function measure(fn: () => unknown, iterations: number): number {
  // Measure a fixed wall-clock duration (10s) rather than a fixed iteration
  // count. A fixed count is unreliable for very fast ops (e.g. native reads
  // at hundreds of millions of ops/s finish in a few ms), which makes the
  // measurement dominated by background noise. Running for a fixed duration
  // averages out that noise. `iterations` is used only to size the batch.
  const minDurationMs = 10_000;
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

/**
 * Create a bounded push function for benchmarks.
 *
 * Growing operations (push) on a single array would otherwise grow the array
 * without bound and exhaust the shared buffers during a long (10s) measurement.
 * This pushes `value` and, once the array reaches `maxLen`, resets its length
 * to 1 so the next push overwrites the slot at index 1 instead of allocating a
 * new one. This keeps the array (and the shared buffer) bounded.
 *
 * `reset` is an optional callback that restores the array to its initial
 * state; it defaults to setting `length = 1`. `onReset` is an optional
 * callback invoked after each reset (e.g. to periodically run a defragmentation
 * pass so dead slots from array growth are reclaimed). A local counter tracks
 * the size so it works with proxies whose `length` may be cached/stale.
 */
export function boundedPush<T>(
  arr: T[],
  value: T,
  initial: T[],
  maxLen = 10_000,
  reset?: () => void,
  onReset?: () => void,
): () => void {
  const doReset =
    reset ??
    (() => {
      arr.length = 1;
    });
  let count = 0;
  return () => {
    arr.push(value);
    count++;
    if (count >= maxLen) {
      doReset();
      onReset?.();
      count = 0;
    }
  };
}
