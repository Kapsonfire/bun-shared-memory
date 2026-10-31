# BENCH.md

Running benchmark results for shared-memory access vs native JS access.

Each row records the results of `bun run bench` after a codebase change. The
table is append-only so the history of performance changes is preserved.

## How to run

```bash
bun run bench
```

This compares shared-memory access against native JS access for every
supported data type and its arrays (primitives, arrays, objects). Results are
reported as ops/sec and relative slowdown.

## Results

| Date | Change | Reads (vs native) | Writes (vs native) | Notes |
|------|--------|--------------------|--------------------|-------|
| 2025-10-31 | Read cache + offset cache (per-key version counter, per-worker value cache, per-worker layout + property cache) | primitives ~3–10×, array index ~6–15×, object props ~9–30× | 70–2400× (serialize + write + bump version; array push re-encodes whole array) | Object property reads: number 13.91×, string 8.85×, boolean 30.03×, bigint 13.90×, array prop index 16.77×. Writes: number 2432×, string 610×, array index 2006×, push 31635×. |
