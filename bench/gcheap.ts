// JS heap that stays behind after N keys were used once and dropped: bun bench/gcheap.ts [count]
import { Shared, SharedMemory, setDefaultMemory } from "../src/index.ts";
setDefaultMemory(new SharedMemory({ maxByteLength: 1024 * 1024 * 1024 }));
const N = Number(process.argv[2] ?? 100_000);
Shared("warm", { id: 0, name: "w", score: 1.5, ok: true });
const sink = (() => {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const w = Shared(`w${i}`, { id: i, name: "w", score: 1.5, ok: true });
    s += w.id;
  }
  return s;
})();
Bun.gc(true);
await Bun.sleep(20);
const before = process.memoryUsage().heapUsed;
let acc = sink;
(() => {
  for (let i = 0; i < N; i++) {
    const o = Shared(`k${i}`, { id: i, name: "n" + i, score: 1.5, ok: true });
    acc += o.id + (o.name as string).length;
  }
})();
Bun.gc(true);
const used = process.memoryUsage().heapUsed;
for (let i = 0; i < 6; i++) {
  await Bun.sleep(20);
  Bun.gc(true);
}
const after = process.memoryUsage().heapUsed;
console.log(
  `${N} keys used once and dropped: while in use ${((used - before) / N).toFixed(0)} B/key, after GC ${((after - before) / N).toFixed(0)} B/key (acc ${acc})`,
);
