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

| Date | Commit | Change | Reads (vs native) | Writes (vs native) | Notes |
|------|--------|--------|--------------------|--------------------|-------|
| 2025-10-31 | `0ac887e` | Read cache + offset cache (per-key version counter, per-worker value cache, per-worker layout + property cache) | primitives ~3–10×, array index ~6–15×, object props ~9–30× | 70–2400× (serialize + write + bump version; array push re-encodes whole array) | Object property reads: number 13.91×, string 8.85×, boolean 30.03×, bigint 13.90×, array prop index 16.77×. Writes: number 2432×, string 610×, array index 2006×, push 31635×. |
| 2025-10-31 | `5953ef7` | In-place updates: set handler writes only the affected slot (object property via cached layout; array index via array ref) instead of decoding + re-encoding the whole value | unchanged | object prop ~60–80×, array index ~55–210×, primitives ~80–250×, push unchanged (~7k–65k×) | Object writes: number 79×, string 62×, array index 212×. Array index writes: number[] 66×, string[] 95×, boolean[] 56×, bigint[] 57×, mixed[] 71×. Property/index writes went from O(n) to O(1). |
