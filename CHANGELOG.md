# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **V2 read/write lock (`RWLock`).** A cross-worker, re-entrant
  `Atomics`-based read/write lock (`src/rwlock.ts`) stored in one Int32 cell
  (bit 0 = WRITER, bit 1 = WRITES_QUEUED, high bits = reader count). Any
  number of readers may hold it concurrently while writers stay exclusive,
  and re-entrancy is tracked per-thread (read, write, and read-inside-write);
  a reader→writer upgrade from the same thread throws (deadlock risk).
  Exposed on `Shared` wrappers via `SharedOptions.rwLock` and the new
  `withRWLock` / `withWriteLock` / `withReadLock` methods, which fall back to
  the shared mutex when no `rwLock` is provided.

## [1.0.1] - 2026-11-07

### Fixed

- **Serialized writes (P1.1).** The normal write path was lock-free: it only
  took the shared mutex while a defragmentation pass was running, so
  concurrent writers to the same value could interleave or read/write stale
  values and lose updates. `writeLock`, `writeProp`, `writeValue`, the object
  accessor setter and the array-property setter now take the shared (re-entrant)
  mutex on every write, serializing writers to the same key. Reads remain
  lock-free. As a consequence writes are slower (~33× → ~47× vs native under
  contention), matching the review's recommendation that writers be mutually
  exclusive.
- **Safe MPSC refcount ring (P1.2).** `pushEvent()` reserved its write slot
  non-atomically (two producers could read the same cursor and overwrite each
  other or publish a half-written slot). The ring now reserves the output
  slot atomically via `Atomics.add` on the write pointer and guards each slot
  with a per-slot sequence cell, so concurrent producers can never claim the
  same slot, publish a torn event, or silently drop a refcount event when the
  queue is full.
- **Bound worker ids to a reusable pool (P1.3).** `allocateWorkerId()` was
  unbounded and could index past the fixed heartbeat/refcount tables. It now
  claims the lowest free bit of a fixed `maxWorkers`-sized bitmap via CAS and
  reuses released ids, throwing a hard error when the pool is exhausted;
  `heartbeat()`/`lastHeartbeat()` are bounds-checked.
- **Refcount multiplicity per worker (P1.4).** The coordinator tracked
  `Set<objectId>` per worker, so a worker holding several references to the
  same objectId (e.g. three `read()` copies) under-released on close/crash.
  `workerRefs` is now `Map<workerId, Map<objectId, count>>` and
  `releaseWorker()` releases every reference a worker holds.
- **Reusable `Notifier` (P2.1).** After one `notify()` the cell stayed `1`, so
  a subsequent `wait()` returned `not-equal` immediately instead of blocking.
  The notify/wait protocol now uses a monotonic sequence counter so repeated
  wait/notify cycles behave correctly.

### Changed

- Remove unused benchmark files and dependencies.

## [1.0.0] - 2026-11-06

### Added

- **Browser support.** The library now runs in modern browsers and Web
  Workers. Bun-specific APIs (`Bun.isMainThread`, `process.on("worker")`) are
  feature-detected (`src/env.ts`) so the module evaluates safely without Bun.
  New exported helpers:

  - `acceptWorker(worker)` — register a Web Worker on the browser main thread
    so its shared-buffer request is answered (a no-op in Bun, which
    auto-discovers workers).
  - `spawnWorker(url, options)` — cross-platform worker spawner that creates a
    `Worker` and wires it into the handshake automatically.
  - `isBun`, `isMainThread`, `isWorkerContext` — environment introspection.

  Requires cross-origin isolation (`COOP: same-origin`, `COEP:
require-corp`) for `SharedArrayBuffer` in the browser. See the README.

- **Browser-capable reference counting.** Reference counting and automatic
  defragmentation now work in the browser too, not just Bun:

  - The `RefCountCoordinator` now uses the shared refcount buffer's
    `workerId` (`allocateWorkerId()`) as the single source of truth and maps
    each worker object to it (previously it used a separate internal counter
    that could diverge from the ids in the event stream — a real bug that only
    appeared to work with a single worker).
  - Workers periodically **heartbeat** (`RefCountTracker.startHeartbeat()`),
    and the coordinator's automatic maintenance reaps a worker whose heartbeat
    stalls — detecting a dead/terminated worker without relying on a `close`
    event (which browsers don't provide).
  - `RefCountCoordinator.unregisterWorker(worker)` is the explicit backstop to
    free a worker's references immediately.

## [0.2.3] - 2026-11-05

### Fixed

- **Concurrent key registration no longer splits a key across two index
  entries**. When several workers created the same key at the same time
  (e.g. two workers both calling `Shared("counter", 0)`), the existence check
  was not atomic: both workers could observe the key as absent and both insert
  it, producing two index-table entries with separate data offsets and version
  cells. Reads and writes then resolved to different entries, so updates became
  invisible across workers (a writer's value appeared stuck at the initial
  value). Key registration now runs under the shared mutex, so only the first
  worker inserts the key and every other worker reuses it.

## [0.2.2] - 2026-11-05

### Added

- **`null` is now a supported shared value**. A new `TYPE_NULL` slot type
  allows `null` to be stored and read anywhere — top-level, object property,
  array element, nested object/array. `undefined` remains intentionally
  unsupported.
- **Nested objects and live `Shared` references**: an object property (or array
  element) may now be another plain object, read lazily and mutated in place
  (e.g. `doc.profile.meta.level++` writes directly to shared memory). Two new
  slot types back this: `TYPE_OBJECT_REF` (a nested object block in the
  DataTable) and `TYPE_KEY_REF` (a live reference to another shared key).
- **Nested `Shared` values**: storing a `Shared` object inside another object
  or array keeps a live reference, so both wrappers stay in sync (no copying).
- **Nested arrays**: arrays may contain other arrays (stored recursively as
  array-refs in the ArrayTable). `arr[0][1] = x`, `arr[0].push(...)`, etc.
- **Defragmentation** remaps nested object references and rewrites their
  property slots; the per-worker object-layout cache is re-validated against
  the global layout version so it stays correct across a defrag.

### Performance

- Cache the key's **version-cell index in the read cache**, so cache-hit reads
  skip the `versionCellIndex` arithmetic and go straight to
  `Atomics.load(view, cached.cell)`.
- Hoist **`getLayoutVersion`** inside lock-free writes: within a write (counter
  > 0) the layout version cannot change, so read it once and reuse it for all
  > cached-offset and ArrayRef checks, saving 2–3 `Atomics.load` ops per write.
  > Array writes improved from ~37× to ~33× slower than native.

### Fixed

- Fix `copyBytes` in the defrag compactor so overlapping source/destination
  ranges (a small string-value block compacting forward over the source region
  of a later array block) are copied overlap-safely. This previously could
  corrupt array contents after a defragmentation that involved interleaved
  string-value and array blocks.

## [0.2.1] - 2026-11-04

### Performance

- Inline the read-cache fast path in `readProp`/`readValue` instead of calling
  `readCachedValue`, which returned a polymorphic `{hit,value}` union and
  allocated an object on every cache hit. Keeping the read path monomorphic
  lets the JIT optimize it: number reads dropped from ~12× to ~6× slower than
  native, boolean reads from ~8.4× to ~5.5×, and all array index reads
  improved (array-read summary ~9.7× → ~8.7×).
- Add `updateBigIntSlot`/`updateArrayBigIntSlot` fast paths that write int64
  bigints directly into the slot, avoiding the `ValueSlot` object allocation
  of the generic encode path. `bigint[]` index writes dropped from ~24.8× to
  ~18× slower than native.
- Extract the array-proxy set handler body into a named `writeArrayProp`
  function and inline the `writeLock`, so no closure is allocated per write.
- Cache the key's version-cell index in the array proxy so writes bump the
  version without a per-write Map lookup. Object array-prop index writes
  dropped from ~33.9× to ~29× slower than native.
- Real-world benchmark: the shared-memory "get user" endpoint improved to
  ~5.15M req/s, widening the gap over the comparison
  backends (sqlite 9.9×, redis 76.5×, mysql 82.0× slower than
  shared memory).

### Benchmark

- Increase `SAMPLES_PER_WORKER` from 5 to 15 for more stable per-run statistics.
- Increase `RUNS_PER_METHOD` from 3 to 5 for better CPU-contention filtering.
- Increase warmup from 1,000 to 5,000 iterations so the JIT and DB caches
  are fully warmed before measurement.
- Add `?pool=8` to MySQL connection strings to avoid per-request connect overhead.
- Add priming queries (`SELECT LIMIT 1` for MySQL, `PING` for Redis) so the
  first measured request does not hit cold-connect latency.

## [0.2.0] - 2026-11-04

### Added

- Slab allocator for string values and arrays. Overwriting a value no longer
  leaves the old block as dead space: freed blocks are pushed onto a shared
  free list (one per table, in a `SharedArrayBuffer`) and reused by later
  allocations, so the tables grow far less over time and defragmentation runs
  less often. The free list is shared across workers via
  `exportBuffers()`/`fromBuffers()`.
- Inline short strings. Strings up to 11 UTF-8 bytes are packed directly into
  the 16-byte value slot (type + length in the top 4 bits of `c`, bytes in
  `a`/`b`/`c`), avoiding a heap allocation and the string-table write on every
  write. Longer strings still use the slab-allocated ArrayTable with in-place
  reuse.
- A complete multi-worker todo-list example (`examples/todo-list/`) that
  serves both the frontend and the API on a single port via Elysia workers.

### Performance

- Cache each object property getter's stable version-cell index (resolved
  lazily on first read) and load the version directly via
  `Atomics.load(mem.versionView, cellIndex)`, replacing the per-read
  `index === null` check and the `getVersion` → `versionCellIndex` multiply +
  divide. Object property reads improved a further 3–17%.
- Cache the top-level array ref and version-cell index on the `SharedRef`
  target so index writes skip the per-write DataTable header reads, Map
  lookups, and the generic encode path. `moveArray` now bumps the layout
  version so the cached ref is invalidated on array growth. Closes the
  remaining array-write gap: number[]/boolean[]/string[] index writes are now
  at or above native speed.
- Cache the array proxy for an object's array property on the accessor getter
  so it isn't recreated on every write (a write bumps the version and
  invalidates the field cache), and cache the property slot offset + array ref
  in the array proxy so index writes skip the per-write `getObjectLayout` Map
  lookup, `properties.get`, and DataTable header reads. Object array-prop
  index writes dropped from ~254× to ~33× slower than native.

### Changed

- Raise the defragmentation trigger: a table now triggers a defrag pass when
  its used length exceeds 80% of capacity (was: when free space fell below
  10%), and only when at least 64 blocks have been freed. Because writes are
  lock-free bump allocations, the used length grows monotonically even when
  the live data set stays the same size; the new threshold defragments only
  when the buffer is genuinely fragmented. During a defrag pass, lock-free
  writes fall back to the mutex and in-flight writes are awaited before
  compacting.

### Fixed

- Fix slab-allocator block corruption in `free()`. `alloc()` padded blocks to
  `MIN_BLOCK_SIZE` internally but callers advanced the cursor by the unpadded
  size, so blocks overlapped and `free()`'s metadata overwrote the neighbour
  block. `alloc()` now returns the actual reserved (padded) size and all
  callers advance by it. Free-list metadata was also reduced from 12 to 8
  bytes (next pointer + size) and the magic marker dropped (double-frees are
  now detected by walking the free list), lowering `MIN_BLOCK_SIZE` from 12 to
  8 so small string blocks no longer inflate the ArrayTable during
  defragmentation.

## [0.1.8] - 2026-11-02

### Fixed

- Share each `GrowableBuffer`'s append cursor across workers. The cursor was a
  private per-instance field, so when a worker reconstructed `SharedMemory`
  via `fromBuffers()` its cursor stayed `0` and the first write in that worker
  wrote at offset `0`, overwriting existing data (e.g. a key string) and
  corrupting the shared value. The cursor now lives in a `SharedArrayBuffer`
  (as a `BigInt64Array`) read/written with `Atomics`, so every worker appends
  at the correct offset. Reported while building the multi-worker todo-list
  example.

## [0.1.7] - 2026-11-02

### Added

- Keep the Index Table in a single growable `SharedArrayBuffer` (capped at
  4 GiB) instead of the chunked logic, so it stays contiguous and cheap to
  address. `SharedMemoryOptions.indexTableMaxByteLength` configures its cap
  (default 4 GiB).
- `maxTotalBytes` now caps the combined physical size of DataTable,
  StringTable, and ArrayTable only (the Index Table is excluded). The budget
  is enforced by an atomic `SharedBudget` counter shared across workers that
  reserves memory before each chunk growth, so the three tables cannot exceed
  the limit even when multiple workers write concurrently.
- Enforce size limits regardless of the configured values: `chunkSize` is at
  least 4 MiB, `maxTotalBytes`/`maxByteLength` are at least 32 MiB, and
  `chunkSize` is raised as needed so no table needs more than 1024 chunks.
  `SharedMemory.maxByteLength` and `SharedMemory.maxTotalBytes` are now public
  read-only fields.

### Performance

- Reclaim memory from inactive chunks after defragmentation. A
  `SharedArrayBuffer` cannot be shrunk, so `GrowableBuffer` replaces each
  inactive chunk with a fresh 4-byte `SharedArrayBuffer`, releasing the old
  full-size buffer so its memory is freed. `defragment()` returns the new
  chunk lists and the main thread broadcasts them to workers via a
  `__chunkUpdate` message; workers apply them with `applyChunkUpdate()`. This
  only runs during defragmentation (rare), so the hot path is unaffected.
- Optimize the budget write hot path: `GrowableBuffer` tracks
  `nextChunkToActivate` (the first not-yet-active chunk) so `ensureCapacity`
  only activates new chunks instead of re-scanning every already-active chunk
  on each write (was O(n) per write as the dataset grew). Writes ~9% faster.

### Changed

- Stabilize the real-world benchmark against CPU contention. The shared-memory
  methodology finishes in tens of milliseconds, so it is sensitive to load
  from other processes (IDE, language servers). Each worker now runs several
  measured samples (default 5) and reports its fastest; each methodology is
  run several times (default 3) and the fastest run is kept. Because
  contention can only slow a run down, the minimum is the best estimate of
  true throughput.

### Fixed

- Resolve chunk offsets with an unsigned right shift (`offset >>> chunkShift`)
  instead of a signed one. A signed 32-bit shift turns offsets at or above
  2 GiB negative, so reads/writes past 2 GiB (e.g. in a >4 GiB chunked buffer)
  hit the wrong chunk or threw. The Index Table and the Data/String/Array
  tables can now be addressed at any offset below the 4 GiB single-SAB cap.
  Reported by [mizulu](https://github.com/mizulu).

## [0.1.6] - 2026-11-02

### Added

- Support shared memory larger than 4 GiB. The single-`SharedArrayBuffer`
  per-buffer architecture is replaced with a chunked `GrowableBuffer`: each
  buffer is backed by multiple equal-size chunks (32 MiB default, power of
  two), so a buffer can exceed the 4 GiB single-SAB limit. Offsets resolve
  O(1) via bit shifts (`offset >> chunkShift`).
- `SharedMemoryOptions.chunkSize` to configure the chunk size (the minimum
  growth step).
- Chunks are pre-allocated at construction (4 bytes each, with
  `maxByteLength = chunkSize`) and activated on first access via
  `SharedArrayBuffer.grow()`. Because `grow()` is visible across all workers
  sharing a buffer, a worker can grow a chunk and every other worker sees it
  immediately — no postMessage broadcast is needed for chunk activation.

### Changed

- `exportBuffers()`/`fromBuffers()` now pass chunk lists instead of a single
  buffer; `fromBuffers` reuses the shared `SharedArrayBuffer`s directly (no
  copy) so writes stay visible across workers. The chunk size is derived from
  each buffer's `maxByteLength` (preserved across `postMessage`), not its
  current 4-byte length.
- Remove the 4 GiB cap on the per-buffer maximum in the `SharedMemory`
  constructor (the chunked `GrowableBuffer` already bypasses the single-SAB
  limit).

### Performance

- After defragmentation, unused chunks are marked inactive:
  `GrowableBuffer.reset()` deactivates chunks beyond the compacted region so
  the GC can reclaim their storage.
- The chunked accessor adds an indirect `chunks[index].view` lookup on the
  write hot path (the price of >4 GiB support): writes ~-15%, array writes
  ~-20%. Reads are unchanged (lock-free cache path).

## [0.1.5] - 2026-11-02

### Changed

- Replace the `Proxy` used for object `SharedRef`s with hard-baked
  `Object.defineProperty` accessor getters/setters, so property reads skip the
  Proxy trap on the hot path (~3× faster object property reads). Methods
  (`read`/`write`/`update`/`key`/`buffer`) move to the prototype so the data
  properties are the only own properties, keeping the JIT shape monomorphic
  (~2× faster than having the methods as own properties). Arrays, primitives,
  and unknown shapes still use the Proxy. Fixed shape is enforced via
  `Object.preventExtensions` plus `configurable: false` accessors.
- Optimize `copyValue` (the `read()` copy) with `Object.assign` + a `for...in`
  array pass (~3.5× faster object `read()`).
- Pass the initial value into `createSharedRef` so the object shape can be
  baked at creation time.

## [0.1.4] - 2026-11-01

### Changed

- Declare `"sideEffects": false` in `package.json` so bundlers can tree-shake
  the library (the modules have no side effects on import).
- Remove the `typescript` peer dependency. The library ships as TypeScript
  source and runs natively in Bun; `bun check` is Bun's own type checker and
  does not require the `typescript` package.

## [0.1.3] - 2026-11-01

### Added

- Real-world benchmark (`bench/real-world/`) comparing shared memory against
  live SQLite, MySQL, and Redis via an Elysia mini API.
- Redis as a fourth benchmark methodology (in Docker).
- Unix-socket transport for MySQL/Redis (Linux only; skipped on macOS).
- Benchmark results written to `benchlogs/<timestamp>-<commit>-real.md`.
- Real-world benchmark results and methodology documented in the README.

### Changed

- MySQL/Redis connections are established before the benchmark (not per
  request) so connection setup is not measured as overhead.
- The benchmark always runs both TCP and Unix-socket transports; the socket
  run is skipped on macOS without error.

## [0.1.2] - 2026-11-01

### Changed

- Unref the maintenance timer so the process can exit naturally.
- Document `init()` as the first call and how to configure memory via `init()`.

## [0.1.1] - 2026-11-01

### Added

- Repository metadata and npm publishing preparation.
- README with package name and install instructions.

### Changed

- Optimize the read hot path: direct cache on the proxy target.
- Optimize `Mutex`: skip notify when no worker is waiting.
- Start the refcount coordinator/tracker automatically in `init()`.
- Document the minimum Bun version (`>= 1.4.0`).

## [0.1.0] - 2026-11-01

### Added

- Initial release: `Shared<T>` Proxy-based API over a 4-buffer shared memory
  architecture (Index Table, DataTable, append-only StringTable, ArrayTable).
- Atomics-based synchronization (`Mutex`, `Notifier`).
- Per-key read cache with cross-worker invalidation and offset cache for
  object property reads.
- O(1) in-place `push`/`pop` with capacity-based array growth.
- Benchmarks for all data types vs native.

[1.0.1]: https://github.com/Kapsonfire/bun-shared-memory/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.2.3...v1.0.0
[0.2.3]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kapsonfire/bun-shared-memory/releases/tag/v0.1.0
