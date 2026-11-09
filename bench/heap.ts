// Per-key JS heap cost: bun bench/heap.ts [kind] [count]
import { Shared, SharedMemory, setDefaultMemory } from "../src/index.ts";

const kind = process.argv[2] ?? "object";
const N = Number(process.argv[3] ?? 20000);
setDefaultMemory(new SharedMemory({ maxByteLength: 1024 * 1024 * 1024 }));

const make = (i: number): unknown => {
  switch (kind) {
    case "number":
      return Shared(`k${i}`, i);
    case "string":
      return Shared(`k${i}`, "hello world long string " + i);
    case "array":
      return Shared(`k${i}`, [1, 2, 3]);
    default:
      return Shared(`k${i}`, { id: i, name: "n" + i, score: 1.5, ok: true });
  }
};
// One key of every kind first: activating a table chunk is a one-off cost of
// tens of MB that would otherwise be divided over the keys.
for (let i = 0; i < 4; i++) make(-1 - i);
Bun.gc(true);
const before = process.memoryUsage().heapUsed;
const refs: unknown[] = [];
for (let i = 0; i < N; i++) refs.push(make(i));
Bun.gc(true);
const after = process.memoryUsage().heapUsed;
// Touch every key once (reads fill the caches).
let sink = 0;
for (let i = 0; i < N; i++) {
  const r = refs[i] as any;
  sink +=
    kind === "object" ? r.id : kind === "array" ? r[0] : (r.read().length ?? 0);
}
Bun.gc(true);
const read = process.memoryUsage().heapUsed;
console.log(
  `${kind}: created ${((after - before) / N).toFixed(0)} B/key, after first read ${((read - before) / N).toFixed(0)} B/key (sink ${sink})`,
);
