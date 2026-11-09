// Quick ns/op of the ref hot paths, one case per process: bun bench/refspeed.ts <case>
import { Shared, SharedMemory, setDefaultMemory } from "../src/index.ts";
setDefaultMemory(new SharedMemory());
const c = process.argv[2]!;
const obj = Shared("o", { n: 1, s: "abc", b: true });
const arr = Shared("a", [1, 2, 3, 4]);
const num = Shared("p", 5);
const many = Array.from({ length: 2000 }, (_, i) =>
  Shared(`m${i}`, { n: i, s: "x" }),
);
const N = 20_000_000;
let sink = 0;
const run = (f: (i: number) => void) => {
  for (let i = 0; i < 2_000_000; i++) f(i);
  const t = performance.now();
  for (let i = 0; i < N; i++) f(i);
  return ((performance.now() - t) * 1e6) / N;
};
const cases: Record<string, (i: number) => void> = {
  "obj read n": () => {
    sink += obj.n;
  },
  "obj write n": (i) => {
    obj.n = i;
  },
  "obj write s": (i) => {
    obj.s = i & 1 ? "abc" : "xyz";
  },
  "many obj read (2000 keys)": (i) => {
    sink += many[i % 2000]!.n;
  },
  "arr read idx": (i) => {
    sink += arr[i & 3]!;
  },
  "arr write idx": (i) => {
    arr[i & 3] = i;
  },
  "num read()": () => {
    sink += num.read();
  },
  "num write()": (i) => {
    num.write(i);
  },
  "obj.read()": () => {
    sink += obj.read().n;
  },
};
console.log(
  c.padEnd(28),
  run(cases[c]!).toFixed(2),
  "ns/op",
  sink === 7 ? "" : "",
);
