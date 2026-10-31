import { Shared, type SharedOptions } from "../src/index.ts";

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
  iterations = 100_000,
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
export function printSummary(): void {
  const reads = results.filter((r) => r.kind === "read");
  const arrayReads = results.filter((r) => r.kind === "array-read");
  const writes = results.filter((r) => r.kind === "write");
  const arrayWrites = results.filter((r) => r.kind === "array-write");

  const avg = (rs: BenchResult[]) =>
    rs.length === 0
      ? 0
      : rs.reduce((sum, r) => sum + r.ratio, 0) / rs.length;

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

/** Measure ops/sec for `fn` over `iterations` invocations. */
function measure(fn: () => unknown, iterations: number): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedMs = performance.now() - start;
  return Math.round(iterations / (elapsedMs / 1000));
}

/** A unique key per benchmark run, so runs don't collide in the registry. */
let keyCounter = 0;
export function nextKey(prefix: string): string {
  return `${prefix}-${keyCounter++}`;
}

/**
 * Shared options for benchmarks: a large maxByteLength so append-only tables
 * don't exhaust the buffer during repeated write benchmarks.
 */
export const benchOptions: SharedOptions = {
  maxByteLength: 512 * 1024 * 1024, // 512 MiB
};
