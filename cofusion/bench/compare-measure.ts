/**
 * Shared measurement logic for the split-process cofusion vs bun-shared-memory
 * comparison.
 *
 * Each library is measured in its own process (see compare-bsm.ts and
 * compare-cofusion.ts) so the two never share a JIT heat-map or memory state.
 * This module provides the robust `measure` used by both child processes.
 */

export interface MeasureOptions {
  /** Wall-clock duration of each measurement round in ms. */
  roundMs?: number;
  /** Number of measurement rounds to run. */
  rounds?: number;
}

/**
 * Measure ops/sec for `fn` over a fixed wall-clock duration.
 *
 * Runs `rounds` measurement rounds of `roundMs` each, drops the fastest and
 * slowest round (outliers), and returns the average of the remaining rounds.
 * The JIT needs several passes to reach a stable state, and individual rounds
 * are noisy (constant-folding boost, tier-up, GC pauses), so dropping the
 * extremes and averaging the rest gives a stable number.
 */
export function measure(
  fn: () => unknown,
  iterations: number,
  opts: MeasureOptions = {},
): number {
  const { roundMs = 10_000, rounds = 5 } = opts;
  const batch = Math.max(1, Math.floor(iterations / 10));
  const samples: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let total = 0;
    const start = performance.now();
    let elapsed = 0;
    do {
      for (let i = 0; i < batch; i++) fn();
      total += batch;
      elapsed = performance.now() - start;
    } while (elapsed < roundMs);
    samples.push(total / (elapsed / 1000));
  }
  // Drop the fastest and slowest round, then average the rest.
  const sorted = [...samples].sort((a, b) => a - b);
  const kept = sorted.slice(1, -1);
  const avg = kept.reduce((s, v) => s + v, 0) / kept.length;
  return Math.round(avg);
}

/** A single measured operation, keyed by name for cross-process merging. */
export interface MeasuredOp {
  name: string;
  ops: number;
}

/**
 * Run a list of named operations, each measured with the robust `measure`,
 * and print the results as a single JSON line on stdout for the orchestrator
 * to consume.
 */
export function runAndEmit(
  ops: Array<{ name: string; fn: () => unknown }>,
  iterations = 1_000_000,
): void {
  // Consume the one-time JIT constant-folding boost on a trivial closure so
  // the first real measurement isn't an outlier.
  const warmConst = 0;
  measure(() => warmConst, 1_000_000, { roundMs: 2_000, rounds: 2 });

  const results: MeasuredOp[] = [];
  for (const { name, fn } of ops) {
    // Warm up the exact closure before measuring.
    const warmup = Math.min(iterations, 10_000);
    for (let i = 0; i < warmup; i++) fn();
    const opsPerSec = measure(fn, iterations);
    results.push({ name, ops: opsPerSec });
    console.error(`${name.padEnd(34)} ${String(opsPerSec).padStart(12)} ops/s`);
  }
  // Single JSON line on stdout; progress goes to stderr so it doesn't pollute
  // the machine-readable output.
  console.log(JSON.stringify(results));
}

/**
 * Measure a single named operation in a fresh process and emit its result as
 * a single JSON line on stdout. Used by the orchestrator to run each operation
 * in its own process, which eliminates JIT interference between operations
 * (e.g. an object read measured right after array writes is deoptimized).
 */
export function runSingle(
  name: string,
  fn: () => unknown,
  iterations = 1_000_000,
): void {
  const warmConst = 0;
  measure(() => warmConst, 1_000_000, { roundMs: 2_000, rounds: 2 });
  const warmup = Math.min(iterations, 10_000);
  for (let i = 0; i < warmup; i++) fn();
  const opsPerSec = measure(fn, iterations);
  console.error(`${name.padEnd(34)} ${String(opsPerSec).padStart(12)} ops/s`);
  console.log(JSON.stringify([{ name, ops: opsPerSec }]));
}
