# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Mutex state cell packs owner and waiters.** The owning thread id is now
  stored in the lock's state cell itself (bit 31 = "someone is waiting"),
  instead of in a separate owner cell. An uncontended `lock()`/`unlock()` pair
  therefore costs two atomic operations (one `compareExchange`, one `exchange`)
  instead of six; every write pays for this. The mutex buffer is now 8 bytes
  (state + re-entrancy depth) instead of 12. Buffers created by older versions
  (4 bytes and 12 bytes) still work: a 12-byte buffer is read as the new
  8-byte layout plus an unused cell.
- **`nextPowerOfTwo` is a bit trick** instead of a shift loop, with an explicit
  `Math.log2` fallback above 2^31.

### Fixed

- **Mutex deadlock under contention.** A waiter marked the waiter bit with
  `Atomics.or` and then slept on the value `or` _returned_ — the old value. If
  the owner released the lock between the waiter's failed acquire and the
  marking, the cell became a lone waiter bit and the waiter slept on `0` while
  nobody stored `0` again: the lock was free but the waiter never woke, until
  the 30 s timeout. Waiters now sleep on `old | waiter bit`, and a cell that is
  a lone waiter bit is claimed directly by the next compare-exchange.

## [1.1.0] - 2026-11-09

### Added

- **Lock timeouts.** All lock waits (`Mutex`, `RWLock`, the object seqlock,
  `waitForWritesToFinish`) are bounded (default 30 s) and throw
  `LockTimeoutError` instead of hanging forever behind a crashed lock holder.
  Configure per thread with `setDefaultLockTimeout(ms)` or per lock with
  `new Mutex(buf, { timeoutMs })` / `new RWLock(buf, { timeoutMs })`.
  `Infinity` restores the old behaviour.
- **Mutex owner tracking.** The owning thread id and re-entrancy depth are
  stored in the shared buffer (default buffer is now 12 bytes). New
  `mutex.owner`, `mutex.heldByCurrentThread` and `mutex.forceUnlock(ownerId)`
  allow recovering a lock held by a dead worker. 4-byte buffers created by
  older versions still work.
- **Reclaim on budget exhaustion.** A write that fails with the new
  `BudgetExceededError` (a `RangeError` subclass) now triggers an immediate
  defragmentation via the `RefCountCoordinator` (`memory.reclaimHook`) and is
  retried once, instead of failing until the next 100 ms maintenance tick
  (which a busy main thread never reaches). Writes in worker threads still
  rely on the main thread's maintenance.

- **V3 Seqlock embedded in each object's version cell.** The read/write lock
  for `withRWLock` / `withWriteLock` / `withReadLock` now lives in the
  object's existing version cell (`INDEX_VERSION_OFFSET` in the Index Table)
  instead of a separate `RWLock` buffer. A single `Atomics.load` yields
  both the version (high bits) and the lock state (low bits), so plain reads
  check consistency without a mutex. Bit layout: bit 0 = WRITER, bit 1 =
  READLOCK, bits 2+ = VERSION (step 4). `bumpVersion` adds 4 (leaves lock
  bits untouched). `withWriteLock` release bumps version and clears WRITER
  in one atomic `add(cell, 3)`. `withReadLock` release clears the bit without
  touching the version. Normal reads wait (`Atomics.wait`) when lock bits are
  set, never set lock bits themselves. Re-entrancy tracked via `writeCellDepths`
  / `readCellDepths` maps keyed by cell index. `SharedOptions.rwLock` removed
  (the cell itself is now the lock). The standalone `RWLock` class remains
  for manual, worker-wide locking.

- **V2 read/write lock (`RWLock`).** A cross-worker, re-entrant
  `Atomics`-based read/write lock (`src/rwlock.ts`) stored in one Int32 cell
  (bit 0 = WRITER, bit 1 = WRITES_QUEUED, high bits = reader count). Any
  number of readers may hold it concurrently while writers stay exclusive,
  and re-entrancy is tracked per-thread (read, write, and read-inside-write);
  a reader→writer upgrade from the same thread throws (deadlock risk).

- **Reclaim in worker threads.** A write that exhausts the budget now triggers
  dead-space reclamation on _any_ thread, not just the main thread:
  `SharedMemory.reclaimInPlace()` compacts the tables in place (no chunk
  replacement, so no broadcast is needed) and the write is retried once. The
  `RefCountCoordinator` still installs its full defragmentation (which also
  releases unused chunks) as the main thread's `reclaimHook`.
  `defragment({ releaseChunks: false })` exposes the in-place mode.
- **Automatic lock recovery.** Workers announce their lock-owner id
  (`getThreadId()`) in the init handshake. When the coordinator unregisters a
  dead worker (close event or heartbeat reap) it force-releases the shared
  mutex if that worker held it, and calls the new `onLockRecovered` option.
  Seqlock cells and the standalone `RWLock` still rely on timeouts only.

- `bun run bench:contention`: multi-worker write throughput benchmark.

### Changed

- **One `SharedMemory` per thread; created on the main thread only.**
  Constructing a second `SharedMemory` in a thread now throws (the per-thread
  read/offset/layout/key caches are keyed by key name, so two instances in one
  thread corrupted each other). A fresh memory (no `buffers`) can only be
  created on the main thread; workers must obtain it through `init()` or
  `SharedMemory.fromBuffers()`. New `SharedMemory.current()` and
  `memory.dispose()` (frees the slot and clears the caches). `init()` on the
  main thread creates the memory; `setDefaultMemory(mem)` now only accepts the
  thread's live instance. **Breaking** for code that created several memories
  in one thread.

- Docs: `DESIGN.md` rewritten to match the code (16-byte slots, slot types,
  Index Table entry, lock-free reads, mutex owner/timeouts, one memory per
  thread). `BENCH.md`/`AGENTS.md` use `variance` instead of the German
  `Varianz`.
- Tests: regression tests for many keys, Index Table insert ordering and
  concurrent key creation from several workers.
- Docs: README/DESIGN now state precisely when a read takes the mutex (only
  whole-value reads after a change; object property reads stay lock-free).
  Test for the browser-main-thread busy-wait fallback.

- **Per-key write locking (lock stripes) instead of one global write mutex.**
  Writes and whole-value cache-miss reads now hold only the lock stripe of
  their key (256 stripes, `keyIndex & 255`), so writers to different keys run in
  parallel and only writers of the same key are serialized. Key creation and
  layout lookups still use the global mutex; defragmentation takes every stripe
  (`SharedMemory.withAllLocks`). The stripes live in the same
  `SharedArrayBuffer` as the global mutex (`lock.buffer`, now 16 KiB for a
  default memory); a plain 12-byte `Mutex` passed as `lock` degrades to a single
  global lock. Measured with `bun run bench:contention` (8 workers, own key
  each): 8.7 M → 305 M writes/s in total. Same-key writers stay serialized.
  `Mutex` gained a `byteOffset` option. The old write counter / defragmenting
  flag methods (`beginWrite`, `endWrite`, `waitForWritesToFinish`, …) are gone.
- The write path no longer does atomic loads of cache lines shared by all
  writers (global-mutex ownership is tracked per thread, the layout version is
  read plainly while a stripe is held): such loads do not scale across workers
  in Bun.
- `update()` / `withWriteLock` callbacks that write a _different_ key take that
  key's stripe as well; opposite lock order in two threads can deadlock and
  surfaces as a `LockTimeoutError`.
- A dead worker's stripes are released together with the global mutex
  (`SharedMemory.forceUnlockAll`).

- Real-world benchmark tooling: `docker-compose.yml` is TCP-only and sets up the MySQL 8.4 native-password auth itself (Unix sockets moved to the Linux-only `docker-compose.sockets.yml`; the containers used to exit immediately on Docker Desktop); MySQL/Redis use fewer samples/runs and the runner prints progress, so the run no longer looks hung (6-7 min per methodology before).
- Docs: README, DESIGN, REFCOUNT and `llms.txt` describe the per-key locking model; `AGENTS.md` requires `bun run bench:contention` for locking changes.

- **Breaking:** `RefCountCoordinator` is now `MaintenanceCoordinator`
  (`new MaintenanceCoordinator(mem, options)`): defragmentation (timer and
  `reclaimHook`), the chunk broadcast and force-releasing the locks of a closed
  worker are unchanged; `minFreeBlocks`, `heartbeatTicks`, `drainEvents` and the
  refcount methods are gone.
- Ordinary writes now wait for another thread's `withReadLock` /
  `withWriteLock` on the same key (before, they ignored it), and a thread never
  waits for lock bits it holds itself.
- A lock-free read under a writer that writes the same key without pause ends on
  the stripe path (a few µs per read instead of a wrong value).
- Each write performs one more atomic operation (the WRITER mark): own-key
  write micro benchmark +8…+18 %, 8-worker write throughput −16…−20 %.
- `bun run bench` runs every case in its own process, with its own measuring
  loop, and each measurement lasts 1 s instead of 5 s (a run takes about 1.5
  minutes). Results are stable run to run but **not comparable** with earlier
  rows, see `BENCH.md`.
- Removed unused imports (`memory.ts`, `shared.ts`, `worker.ts`), dead
  assignments and the never-read `workerIdByWorker` map. No behavior change.
- `bun run test:coverage` writes `coverage/lcov.info`; `sonar-project.properties`
  now declares the test sources and the lcov report path so Sonar can show
  coverage once the analysis runs after the tests (CI-based analysis).

### Removed

- **Reference counting.** The counters were never read for any decision (nothing
  was freed based on them) while every `read()` of an object/array pushed an
  event into a ring buffer, and the ring needed stall-skip logic for killed
  workers. Removed: `RefCountBuffer`, `RefCountCoordinator`, `RefCountTracker`,
  `getDefaultTracker`, `SharedOptions.refCount`, `SharedMemory.refCountBuffer` /
  `attachRefCountBuffer`, the `refCount` entry of `exportBuffers()`, the
  heartbeat, and `REFCOUNT.md`. Object and array blocks keep a reserved header
  word, so the memory layout is unchanged. The ring fixes listed under
  Fixed below were made before the ring was removed and no longer apply.
- Worker ids are no longer allocated from a shared buffer; the dead-worker
  detection by heartbeat (for browsers without a `close` event) is gone. Use
  `unregisterWorker(worker)` for terminated workers, otherwise waiters time out
  (`LockTimeoutError`, 30 s by default).

### Fixed

- **Refcount ring wedged by a killed worker; `drainEvents` starving the event
  loop.** A worker terminated between reserving a ring slot and publishing it
  left an unpublished slot behind: the consumer could never move past it, the
  ring filled up and every later worker blocked in `pushEvent` forever (the real
  benchmark, which terminates its workers after each run, hung in ~5 % of the
  runs). `popEvent` now skips a slot that stayed unpublished for `stallMs`
  (default 300 ms) once the coordinator has seen a worker die
  (`RefCountBuffer.noteWorkerDeath`, called from `unregisterWorker`); each slot
  needs its own timer, so producers still waiting for their slot on a full ring
  are never skipped. Separately, `drainEvents` ran until the ring was empty,
  which never happens while producers keep it full, starving the main thread's
  event loop (timers, worker messages); a drain is now bounded
  (`drainEvents(maxEvents)`) and continues on later event-loop turns.
- **Workers stalled on a full refcount event ring.** The ring is bounded (a full
  ring blocks the producer, since v1.0.0) and was only drained by the main
  thread's 100 ms maintenance timer. A worker reading in a loop (each `read()`
  pushes an acquire event) therefore stalled for up to a whole tick every
  1024 events, capping all workers together at ~10 000 events/s; the real-world
  benchmark (`bun run bench:real`) appeared to hang. A producer that finds the
  ring full now wakes the coordinator immediately (`Atomics.waitAsync`), and the
  default ring is 4096 slots. 20 000 `read()` calls in a worker: 1.2 s → 6 ms.
  Where `Atomics.waitAsync` is unavailable the timer remains the only trigger.
- **Mutex re-entrancy across instances.** Re-entrancy was tracked per `Mutex`
  object, so two instances over the same buffer in one thread deadlocked. It is
  now tracked in the shared buffer.
- **`Atomics.wait` on the browser main thread** threw a `TypeError`. Locks,
  `Notifier` and the seqlock now fall back to a bounded busy-wait there.
- A timed-out `RWLock` writer no longer leaves the `WRITES_QUEUED` bit set,
  which would have blocked new readers.

- **Quadratic key lookup.** `SharedMemory.lookupIndex` scanned the whole Index
  Table and decoded every key string on each lookup, so creating many keys was
  O(n²) (16 000 new keys took ~44 s). Each instance now keeps an incrementally
  filled key → index `Map` (keys are never removed or reordered), so lookups
  are O(1) amortized (16 000 keys: ~0.33 s).
- **Index insert race.** `insert` published the new entry count before the
  entry was written (and before the Index Table was grown), so a lock-free
  reader could see a half-initialized entry. The entry is now fully written
  first and the count is published last with `Atomics.store`.

- **Superlinear key creation.** Index keys were interned in the LRU string
  cache, evicting repeating property names and making every eviction scan the
  Map's tombstones (88 % of the time at 64 000 keys). Keys are no longer
  interned: creating 64 000 keys takes ~0.13 s instead of ~1.2 s and the
  per-key cost is constant.
- The string intern cache is now dropped when the layout version changes, so a
  defragmentation by another thread cannot leave stale string refs behind.

- **`Shared(key, loader)`.** Concurrent calls for one key now share a single
  load (the loader ran once per call and a second call returned the wrapper
  before the value existed); a cached wrapper is returned as a Promise like the
  overload promises; the loader is skipped when the key already exists in shared
  memory; and a rejecting loader no longer leaves a registered wrapper for a key
  that was never written, so a later call can retry.
- **Silent data loss for unsupported objects.** `Date`, `Map`, `Set`, `RegExp`,
  typed arrays, `Error`, ... were stored as an empty object `{}`. They now throw
  a `TypeError` naming the type (class instances with data properties are still
  accepted). Sparse arrays throw a clear message instead of a cryptic error.
- **Torn reads of object properties.** A lock-free property read that overlapped
  a write could return a value assembled from two writes: strings (inline and
  heap) were seen with the offset of one value and the length of another, with
  no error (measured: 205 000 wrong values in 52 M reads against a writer that
  alternates two strings). Ordinary writes now mark the key's version cell while
  they write (WRITER bit) and bump the version when done; lock-free reads
  validate the cell after decoding and decode again if it changed (a seqlock).
- `withWriteLock` / `withReadLock` / `withRWLock` passed an internal helper
  object to the callback instead of the shared reference, so `self.prop = x`
  inside the callback silently wrote a local property. The callback now gets the
  reference.
- SonarCloud quality gate: `init()` no longer creates the main-thread memory as
  a bare `new SharedMemory(...)` statement (reported as a reliability bug); it
  passes the instance to `setDefaultMemory`.

### Performance

Measured with a micro benchmark, each case in its own process, against
`release/1.1.0` (ns per operation):

| Operation                                  | before      | after       | change        |
| ------------------------------------------ | ----------- | ----------- | ------------- |
| `read()` of an object right after a write  | 1017        | 219         | −78 %         |
| array element read right after a write     | 202         | 61          | −70 %         |
| `update()` (read-modify-write)             | 325         | 98          | −70 %         |
| object property write (number)             | 31.8        | 17.8        | −44 %         |
| object property write (short string)       | 44.5        | 20.5        | −54 %         |
| object property write (boolean / bigint)   | 29.8 / 35.5 | 19.6 / 21.0 | −34 % / −41 % |
| top-level `write()` (number / string)      | 34.7 / 54.8 | 23.5 / 31.4 | −32 % / −43 % |
| array element write / array property write | 41.5 / 42.3 | 31.4 / 28.7 | −24 % / −32 % |
| property read, cache hit                   | 3.1–3.7     | 2.7–3.0     | −10 … −27 %   |

Reads of unchanged values (cache hits) were already close to the floor and
barely move; array element access is dominated by the engine's `Proxy` call.

- **One chunk resolution per value slot.** `GrowableBuffer.viewAt`/
  `localOffset` resolve the chunk once for the four fields of a 16-byte slot
  (it was once per field; `activate()` alone was a third of a number write).
  Slots straddling a chunk boundary (defragmentation packs blocks back to
  back) fall back to per-field access (`slotLimit`).
- **Fixed-length chunk views.** A chunk grows exactly once, so the view created
  after that growth is fixed-length, which JavaScriptCore accesses 7–15 %
  faster than a length-tracking view; every other view stays length-tracking
  and keeps seeing growth by other threads.
- **`StripeLock`.** The per-key stripes keep their re-entrancy depth in a plain
  field (4 instead of 8 atomic operations per uncontended lock/unlock); the
  owner id is still published for crash recovery.
- **No closure per write.** Object property, array element, `writeProp` and
  `writeValue` writes create their lock body once and pass the value through
  saved/restored variables.
- **Inline strings without `TextEncoder`/`TextDecoder`.** ASCII strings of up to
  11 characters are packed from char codes; values are stored inline already
  when they are created (not only on in-place writes), so short strings never
  touch the heap.
- **Allocation-free reads on a cache miss.** Primitive slots are decoded from
  the chunk view without a `ValueSlot` object; an object is decoded with the
  property names and slot offsets of its cached layout instead of reading every
  name from the StringTable (a `TextDecoder` call each); a single array
  element after a write is read from its own slot instead of decoding the whole
  array or root object (the second miss at the same version still decodes and
  fills the cache).
- **Whole-object writes** (`write(obj)`, `update()`) use the cached layout too,
  and validate before writing: a write with a missing or extra property is
  rejected without having overwritten any property (previously earlier
  properties were already written).
- `waitForVersionCell` loads the version first and only consults the
  lock-depth maps when lock bits are set; `copyValue` allocates its cycle map
  only when it meets a live `Shared` reference; array keys are parsed with a
  character loop instead of a regular expression (`parseInt`/`isNaN` would
  accept keys like `"12abc"`).

- **Memory per key (JS heap).** Every key used to own a prototype object, 6+
  closures and a Proxy handler, which also gave each key its own set of
  hidden classes (Structures) with property tables. The public methods, the
  prototype and the Proxy handler are now shared by all keys, and the
  per-property state is a plain object, created lazily where possible. Measured
  with `bun bench/heap.ts` (20 000 keys, after a warm-up): object with 4
  properties 3.8 → 2.0 KB, number/string/array 1.4 → 0.9 KB. Reads over many
  keys got faster as well, because objects of one shape now share their
  Structure (2000 different keys: 47.7 → 16.5 ns per property read, measured
  with `bench/refspeed.ts`); in the benchmark suite writes are unchanged and
  single-key reads are 0…13 % slower (object property reads -5…-13 %). The
  methods (`read`, `write`, ...) are shared functions that use `this`, so
  detaching one (`const { write } = ref`) no longer works. `read()` through a
  Proxy (primitives, arrays) keeps one trap call by creating its function on
  first use, so a detached `read` still works there.
- **Unused wrappers are garbage collected.** The per-thread registry held every
  wrapper forever (1-2 KB each) and the caches kept an entry per key ever
  touched, including the last decoded value. Wrappers are now held through
  `WeakRef`; when one is collected a `FinalizationRegistry` callback drops the
  key's read, index, offset and layout cache entries. While a reference is
  alive, `Shared(key)` still returns the same object. Measured with
  `bun bench/gcheap.ts` (100 000 object keys used once and dropped): 2387 B
  per key stayed in the heap before, 159 B afterwards. Cost: a repeated
  `Shared(key)` for a held key takes 6.4 instead of 4.0 ns. What remains per
  key is the per-thread key → index map of the memory itself (every key of the
  shared memory a thread has looked up).
- **Readers of one hot key scale.** Cache hits read the version cell with a plain
  load instead of `Atomics.load`: 8 workers reading the same key went from 27 to
  1751 M reads/s (they used to get slower with every worker added); the
  single-thread property read hit also got faster (2.7 → 1.9 ns). New
  `bun run bench:readscale`.

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

[1.1.0]: https://github.com/Kapsonfire/bun-shared-memory/compare/v1.0.1...v1.1.0
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
