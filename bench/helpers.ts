import { Shared, type SharedOptions } from "../src/index.ts";

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

  console.log(
    `${name.padEnd(34)} native ${String(nativeOps).padStart(12)} ops/s | shared ${String(sharedOps).padStart(12)} ops/s | ${slower}`,
  );
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
