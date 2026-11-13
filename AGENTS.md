# AGENTS.md

Guidelines for AI agents and contributors working in this repository.

## Project overview

A TypeScript library for Bun and the browser that shares data between
workers/threads using `SharedArrayBuffer`. It uses a 4-buffer architecture
(Index Table, DataTable, append-only StringTable, ArrayTable), a Proxy-based
getter/setter API, and Atomics-based synchronization (Mutex/Notifier).

Key entry points:

- `src/memory.ts` — core 4-buffer shared memory manager
- `src/shared.ts` — Proxy-based `Shared`/`SharedRef` API with read/offset caches
- `src/growable-buffer.ts` — growable `SharedArrayBuffer` helper
- `src/mutex.ts`, `src/notifier.ts` — Atomics-based synchronization
- `src/index.ts` — public exports

## Benchmarks are run by a human, never by an agent

**Local benchmark runs are executed by a human.** An agent must not run
`bun run bench`, `bun run bench:contention`, `bun run bench:readscale`,
`bench/refspeed.ts`, `bench/heap.ts`, `bench/gcheap.ts` or the real-world
benchmark itself — it asks the human to run them.

- The agent prepares the run: which commit to measure, which previous row to
  compare against, and the exact commands to run. Then it hands them to the
  human and waits.
- **While a benchmark is running, the agent does nothing else.** No other
  commands, no tests, no subagents, no background tasks — anything competing
  for CPU or memory skews the numbers.
- The human says when the run is finished. Only then does the agent read the
  results and write the `BENCH.md` row.
- `bun test` and `bun run typecheck` are unaffected by this rule and may still
  be run by the agent — but not while a benchmark is in progress.

## Required workflow before every commit

1. **All tests must pass.** Run `bun test`. Do not commit if any test fails.
   `bun run test:coverage` additionally writes `coverage/lcov.info`, which the
   Sonar configuration (`sonar-project.properties`) reads.
2. **A benchmark is needed for every codebase change.** Ask the human to run
   `bun run bench` (or `bun bench/bench.ts`), then record the results in the
   running table in `BENCH.md` (see below).
3. **Locking changes also need the contention benchmark.** If you touch locks,
   the write path or defragmentation, the human additionally runs
   `bun run bench:contention` and the numbers go into `BENCH.md`.
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
  A run on uncommitted changes gets `-dirty` in its name, and a second run of
  the same state a number (`-2`, `-3`, …) instead of overwriting the first.
  Each log lists the machine (CPU, RAM, OS, kernel, architecture, Bun):
  results from different machines are not comparable, so compare only logs of
  the same machine, and re-measure the previous commit when there is none.
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
