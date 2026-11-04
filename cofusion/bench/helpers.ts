import { createArena } from "cofusion";

/**
 * Benchmark helper for the cofusion triage. Mirrors `bench/helpers.ts` of
 * bun-shared-memory: compares a native operation against a cofusion shared
 * operation and reports ops/sec and the ratio.
 */

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

/** Classify a benchmark name into a summary category. */
function classify(name: string): BenchResult["kind"] {
  const isArray = /\[\]|array/i.test(name);
  if (/read/i.test(name)) return isArray ? "array-read" : "read";
  if (isArray && /write|push|pop/i.test(name)) return "array-write";
  return "write";
}

/**
 * Run a shared-vs-native benchmark for a single operation.
 * `native` and `shared` are the two functions to compare.
 */
export function benchPair(
  name: string,
  native: () => unknown,
  shared: () => unknown,
  iterations = 1_000_000,
): void {
  if (!warmedUp) {
    warmedUp = true;
    const warmConst = 0;
    measure(() => warmConst, 1_000_000, 2_000);
    measure(() => warmConst, 1_000_000, 2_000);
  }

  const warmup = Math.min(iterations, 10_000);
  for (let i = 0; i < warmup; i++) {
    native();
    shared();
  }

  measure(native, iterations, 2_000);

  const sharedOps = measure(shared, iterations);
  const nativeOps = measure(native, iterations);

  const ratio = nativeOps / sharedOps;
  const slower =
    ratio >= 1
      ? `${ratio.toFixed(2)}× slower`
      : `${(1 / ratio).toFixed(2)}× faster`;

  results.push({ name, nativeOps, sharedOps, ratio, kind: classify(name) });

  console.log(
    `${name.padEnd(34)} native ${String(nativeOps).padStart(12)} ops/s | cofusion ${String(sharedOps).padStart(12)} ops/s | ${slower}`,
  );
}

/** Print a summary separating reads, array reads, writes, and array writes. */
export function printSummary(): void {
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
}

/** Measure ops/sec for `fn` over a fixed wall-clock duration. */
function measure(
  fn: () => unknown,
  iterations: number,
  minDurationMs = 5_000,
): number {
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

/** A shared arena for all cofusion benchmarks. */
export const arena = createArena({ initialSize: 64 * 1024 * 1024 });
