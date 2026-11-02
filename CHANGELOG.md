# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] - 2026-11-02

### Performance

- Reclaim memory from inactive chunks after defragmentation. A
  `SharedArrayBuffer` cannot be shrunk, so `GrowableBuffer` replaces each
  inactive chunk with a fresh 4-byte `SharedArrayBuffer`, releasing the old
  full-size buffer so its memory is freed. `defragment()` returns the new
  chunk lists and the main thread broadcasts them to workers via a
  `__chunkUpdate` message; workers apply them with `applyChunkUpdate()`. This
  only runs during defragmentation (rare), so the hot path is unaffected.

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

[0.1.7]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Kapsonfire/bun-shared-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kapsonfire/bun-shared-memory/releases/tag/v0.1.0
