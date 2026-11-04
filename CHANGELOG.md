# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
