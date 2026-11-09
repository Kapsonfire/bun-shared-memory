# AGENTS.md

Guidelines for AI agents and contributors working in this repository.

## Project overview

A TypeScript library for the Bun runtime that shares data between
workers/threads using `SharedArrayBuffer`. It uses a 4-buffer architecture
(Index Table, DataTable, append-only StringTable, ArrayTable), a Proxy-based
getter/setter API, and Atomics-based synchronization (Mutex/Notifier).

Key entry points:

- `src/memory.ts` — core 4-buffer shared memory manager
- `src/shared.ts` — Proxy-based `Shared`/`SharedRef` API with read/offset caches
- `src/growable-buffer.ts` — growable `SharedArrayBuffer` helper
- `src/mutex.ts`, `src/notifier.ts` — Atomics-based synchronization
- `src/index.ts` — public exports

## Required workflow before every commit

1. **All tests must pass.** Run `bun test`. Do not commit if any test fails.
   `bun run test:coverage` additionally writes `coverage/lcov.info`, which the
   Sonar configuration (`sonar-project.properties`) reads.
2. **Run the benchmark for every codebase change.** Run `bun run bench` (or
   `bun bench/bench.ts`). Record the results in the running table in
   `BENCH.md` (see below).
3. **Locking changes also need the contention benchmark.** If you touch locks,
   the write path or defragmentation, additionally run
   `bun run bench:contention` and record the numbers in `BENCH.md`.
4. **Typecheck.** Run `bun run typecheck` (`bun check`). Keep it clean.
5. **Format.** Run `bun fmt` if formatting is expected.

## Benchmark documentation (BENCH.md)

`BENCH.md` contains a running, chronological table of benchmark results. For
**every** codebase change (even ones expected to have no performance impact):

- Run `bun run bench`. Every case runs in its own process with its own measuring
  loop (about 1.5 minutes per run), so results do not depend on the order of the
  cases. Rows measured before this method (see `BENCH.md`) are not comparable;
  compare against a run of the previous commit made the same way.
- The benchmark automatically writes a full log to
  `benchlogs/<unix-timestamp>-<commit-hash>.md` (one file per run, named after
  the commit it was measured on, timestamp-prefixed for chronological sorting).
- Add a new row to the table in `BENCH.md` with:
  - a date/commit reference,
  - a short description of the change,
  - the measured results (or a summary of the key numbers),
  - the `Δ vs prev` delta compared to the previous row.

### Delta convention

The `Δ vs prev` column compares each row against the previous version:

- `+X%` = performance gain (faster)
- `-X%` = performance loss (slower)
- `0%` = no measurable change
- `±<5% (variance)` = change under 5% is treated as test variance, not a real
  change. Document it as such rather than as a gain/loss.

Always record the actual measured numbers, even when the delta is expected to
be zero. If the benchmark shows high variance, run it longer or more times to
reduce noise before recording the result.

Keep the table append-only so the history of performance changes is preserved.

## Conventions

- The user communicates in German and English; code and docs may use either.
- Shared values have a fixed shape: object properties may not be added or
  removed. Do not change this invariant.
- Keep hot paths (e.g. `readValue`, proxy `get`/`set`) free of debug counters
  and `console.log` — they disrupt the JIT and skew benchmarks.
- `read()` returns a copy; property access through the proxy reads from the
  cache directly.
