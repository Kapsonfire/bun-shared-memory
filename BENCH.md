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
| 2025-10-31 | `b502e04` | O(1) in-place push/pop: arrays reserve capacity padding in the ArrayTable; push writes into padding (relocating with doubled capacity when exhausted), pop decrements length; push/pop routed through mutateArrayRef without decoding the whole array/object | unchanged | push ~50–220× (was ~7k–65k×), object array-prop push ~50–100× (was ~22k×) | Push results: number[] 124×, string[] 112×, boolean[] 127×, bigint[] 67×, mixed[] 126×, object array-prop push 97×. Push went from O(n) re-encode to O(1) amortized. |
| 2025-10-31 | `7f0c3f5` | Reuse a single module-level DataView for 64-bit slot packing (number/bigint encode+decode) instead of allocating a buffer per call | unchanged | bigint write ~57× (was ~200×), number write ~77× | bigint write 57×, number write 77×, bigint[] write index 84×, bigint[] push 99×. BigInt stays stored as a real int64 (no string round-trip). |
| 2025-10-31 | `34ac1eb` | Support bigints of arbitrary size: values ≤ 64 bits stay as fast int64 slots; larger values stored as decimal strings in the StringTable (new TYPE_BIGINT_STR slot) | unchanged | unchanged for ≤64-bit bigints (~57×) | Fixes silent truncation of bigints > 64 bits (e.g. 2**100n became 0). Small bigints keep int64 speed; large ones use the StringTable. |
| 2025-10-31 | `084e2be` | Cache the stable key index per worker (indexCache + getIndex/getOffset) to avoid the linear Index Table scan + key-string decode on every lookup | unchanged | writes ~2–4× faster: number 28×, bigint 25×, boolean 57×, string 41×, object prop 37×, array push 49× | The Index Table lookup (linear scan + TextDecoder per key) was the write bottleneck. Now the index is resolved once and the offset read via a single Int32. |
| 2025-10-31 | `16d26b6` | Add pop benchmarks for all array types (pop is already O(1) in-place via mutateArrayRef) | unchanged | pop ~36–112× (comparable to push) | Pop results: number[] 62×, string[] 57×, boolean[] 36×, bigint[] 112×, mixed[] 4×. Pop decrements the array length in place (O(1)); bigint pop is higher because it decodes the popped element. |
| 2025-10-31 | `955f5de` | Add read/write-separated summary to the benchmark output | — | — | `printSummary()` classifies each benchmark as read or write and prints average/min/max slowdowns. Reads 16.4×, Writes 51.2×. |
| 2025-10-31 | `aafac7c` | String interning: repeated writes of the same string reuse a cached StringTable ref (per-worker LRU cache, grows dynamically, evicts LRU) instead of re-encoding + re-copying bytes | unchanged | object string-prop write 28.7× (was 161.6×), string write 20.8× (was 31×) | The `object · write string prop` outlier (161×) was the StringTable re-encode on every write. Interning with a fast-path for the most-recent string makes repeated string writes ~5× faster. Writes overall 43.3× (was 49.9×). |
| 2025-10-31 | `aeca1f5` | Add `maxTotalBytes` total memory budget: a `SharedBudget` caps the sum of all buffers' physical sizes; each buffer's own `maxByteLength` is `min(4 GiB, maxTotalBytes)` | unchanged | unchanged | Budget is only checked on buffer growth (allocation path), not on the read/write hot path. No performance impact. |
| 2025-10-31 | `7bdf2a6` | Store each key's version counter in the index entry (4th field, `INDEX_ENTRY_SIZE` 12→16) instead of a separate versionTable buffer; `getVersion`/`bumpVersion` address it via an Int32Array view over the index table | Reads 16.6× (min 5.1×, max 34.5×), array reads 16.6× (min 7.3×, max 54.3×) | Writes 29.7× (min 23.5×, max 52.7×), array writes 44.5× (min 4.2×, max 123.7×) | Version cell is still an Int32Array + Atomics, so the version check cost is unchanged. One fewer buffer to manage/share. Net memory per key unchanged (16 bytes vs 12+4). |
