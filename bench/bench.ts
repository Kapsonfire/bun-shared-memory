// Runs every benchmark case in its own fresh process and prints the summary.
//
// The cases share nothing: with one process, the JIT type feedback of earlier
// cases (polymorphic call sites in the library) changed the numbers of later
// ones, so a result depended on the order of the cases. Each case now starts
// cold, like a real program that only uses one of them.
import { printSummary, recordResult } from "./helpers.ts";

const script = new URL("./index.ts", import.meta.url).pathname;

function runCase(env: Record<string, string>): string {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, script],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`benchmark process failed (${JSON.stringify(env)})`);
  }
  return proc.stdout.toString();
}

function parse<T>(output: string, tag: string): T {
  const line = output.split("\n").find((l) => l.startsWith(`${tag} `));
  if (line === undefined) {
    throw new Error(`no ${tag} line in the output of a benchmark process`);
  }
  return JSON.parse(line.slice(tag.length + 1)) as T;
}

const names = parse<string[]>(runCase({ BENCH_LIST: "1" }), "BENCHCASES");
for (const name of names) {
  const r = parse<{ name: string; nativeOps: number; sharedOps: number }>(
    runCase({ BENCH_CASE: name }),
    "BENCHRESULT",
  );
  recordResult(r.name, r.nativeOps, r.sharedOps);
}

await printSummary();
