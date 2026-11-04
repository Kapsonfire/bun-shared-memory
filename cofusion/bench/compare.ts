/**
 * Direct performance comparison: cofusion vs bun-shared-memory.
 *
 * Each operation is measured in its own fresh child process (compare-bsm.ts
 * and compare-cofusion.ts) so no two operations share a JIT heat-map. This
 * eliminates the JIT interference that otherwise deoptimizes later operations
 * (e.g. an object read measured right after array writes drops from ~500M to
 * ~170M ops/s). The processes run sequentially and independently.
 *
 * The reported ratio is `bsmOps / cofusionOps`:
 *   - > 1  → bun-shared-memory is faster
 *   - < 1  → cofusion is faster
 */

import { OP_NAMES } from "./ops.ts";

interface MeasuredOp {
  name: string;
  ops: number;
}

interface CmpResult {
  name: string;
  bsmOps: number;
  cofusionOps: number;
  ratio: number;
}

const results: CmpResult[] = [];

/** Run a child process for one operation and resolve with its single JSON line. */
function runChild(script: string, opName: string): Promise<MeasuredOp[]> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(["bun", script, opName], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = proc.stdout!.getReader();
    let out = "";
    const readAll = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
    })();
    Promise.all([readAll, proc.exited]).then(([, code]) => {
      if (code !== 0) {
        reject(new Error(`${script} exited with code ${code}`));
        return;
      }
      const line = out.trim().split("\n").pop()!;
      resolve(JSON.parse(line) as MeasuredOp[]);
    });
  });
}

/** Merge the two libraries' per-operation results into ratios. */
function merge(bsm: MeasuredOp[], cofusion: MeasuredOp[]): void {
  const cofByName = new Map(cofusion.map((o) => [o.name, o.ops]));
  for (const b of bsm) {
    const cofOps = cofByName.get(b.name);
    if (cofOps === undefined) {
      console.error(`No cofusion result for "${b.name}"`);
      continue;
    }
    results.push({ name: b.name, bsmOps: b.ops, cofusionOps: cofOps, ratio: b.ops / cofOps });
  }
}

/** Print the comparison as a compact table. */
function printSummary(): void {
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

  const header = `│ ${"operation".padEnd(26)} │ ${"bsm ops/s".padStart(12)} │ ${"cofusion ops/s".padStart(14)} │ ${"ratio".padStart(6)} │ winner        │`;
  const sep = `├${"─".repeat(28)}┼${"─".repeat(14)}┼${"─".repeat(16)}┼${"─".repeat(8)}┼${"─".repeat(14)}┤`;
  const top = `┌${"─".repeat(28)}┬${"─".repeat(14)}┬${"─".repeat(16)}┬${"─".repeat(8)}┬${"─".repeat(14)}┐`;
  const bottom = `└${"─".repeat(28)}┴${"─".repeat(14)}┴${"─".repeat(16)}┴${"─".repeat(8)}┴${"─".repeat(14)}┘`;

  console.log("\n── bsm vs cofusion ─────────────────────────────────────────");
  console.log(top);
  console.log(header);
  console.log(sep);
  for (const r of results) {
    const winner = r.ratio >= 1 ? "bsm" : "cofusion";
    console.log(
      `│ ${r.name.padEnd(26)} │ ${fmt(r.bsmOps).padStart(12)} │ ${fmt(r.cofusionOps).padStart(14)} │ ${r.ratio.toFixed(2).padStart(6)} │ ${winner.padEnd(13)}│`,
    );
  }
  console.log(bottom);

  const avg =
    results.length === 0
      ? 0
      : results.reduce((s, r) => s + r.ratio, 0) / results.length;
  const min = Math.min(...results.map((r) => r.ratio));
  const max = Math.max(...results.map((r) => r.ratio));
  const bsmWins = results.filter((r) => r.ratio >= 1).length;

  console.log(
    `Average ${avg.toFixed(2)}× · min ${min.toFixed(2)}× · max ${max.toFixed(2)}× · bsm wins ${bsmWins}/${results.length}`,
  );
  console.log("(ratio > 1 → bun-shared-memory faster; < 1 → cofusion faster)");
}

// Measure each operation in its own fresh process, sequentially, for both
// libraries. This keeps every measurement free of JIT interference.
for (const opName of OP_NAMES) {
  console.log(`\n── ${opName} ───────────────────────────────────────────`);
  const bsm = await runChild("compare-bsm.ts", opName);
  const cofusion = await runChild("compare-cofusion.ts", opName);
  merge(bsm, cofusion);
}

printSummary();
