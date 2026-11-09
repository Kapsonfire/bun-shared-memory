// Every benchmark case. Run through `bench.ts` (one fresh process per case);
// `bun benc./index.ts` alone runs them all in this process.
import "./primitives.ts";
import "./arrays.ts";
import "./objects.ts";
import "./cache.ts";
import { finishListing, printSummary } from "./helpers.ts";

finishListing();
if (process.env.BENCH_LIST !== "1" && process.env.BENCH_CASE === undefined) {
  await printSummary();
}
