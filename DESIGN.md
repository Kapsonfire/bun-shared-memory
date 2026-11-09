# DESIGN.md — Shared Memory Architecture

## Overview

This document describes the memory layout and architecture for sharing data between Bun workers using `SharedArrayBuffer`.

The core idea: **SharedArrayBuffers are growable** (via `grow()`, when created with `maxByteLength`). When a string or array grows, the buffer can be extended. However, if the growing element is not at the end of the buffer, all subsequent data must be shifted. To avoid this, we use **append-only tables** for variable-length data (strings and arrays), so growth never requires shifting existing data.

> **Note on growability**: `SharedArrayBuffer` supports `grow(newLength)` when created with `{ maxByteLength }`. Growth preserves existing data, can only grow up to `maxByteLength`, and cannot shrink. All workers sharing the buffer see the growth immediately (same buffer reference).

## The Four Buffers

```
┌─────────────────────────────────────────────────────────────┐
│ 1) Index Table   — maps object keys → DataTable offsets      │
├─────────────────────────────────────────────────────────────┤
│ 2) DataTable     — stores objects, arrays, strings as        │
│                    references (pointers) into tables 3 & 4   │
├─────────────────────────────────────────────────────────────┤
│ 3) StringTable   — append-only storage for strings           │
├─────────────────────────────────────────────────────────────┤
│ 4) ArrayTable    — append-only storage for arrays            │
└─────────────────────────────────────────────────────────────┘
```

### 1) Index Table

Maps a shared object's key to its location in the DataTable.

- A single growable `SharedArrayBuffer` (capped at 4 GiB). A 4-byte header
  holds the entry count; entries follow, 16 bytes each (see layout below).
- Keys are never removed or reordered, so a key's **index** (its position) is
  stable for its lifetime. The index also addresses the key's **version cell**
  (see Synchronization).
- Lookup by key name: each `SharedMemory` keeps a per-instance
  `Map<key, index>` that is filled incrementally from the entries added since
  the last scan, so a lookup is O(1) amortized (every key string is decoded at
  most once per thread).
- An entry is written completely _before_ the entry count is published
  (`Atomics.store`), so lock-free readers never see a half-initialized entry.
  Inserts are serialized by the global mutex.

### 2) DataTable

Stores the actual shared values. Each value is one of:

- **Object**: a fixed set of property slots. Each slot holds either a primitive value directly, or a _reference_ to a string/array in tables 3/4.
- **Array**: a reference to an entry in the ArrayTable.
- **String**: a reference to an entry in the StringTable.
- **Primitive**: stored inline (number, boolean, bigint).

Because objects/arrays/strings are stored as fixed-size references, the DataTable itself never needs to shift when a string or array grows — only the reference (offset/length) is updated.

### 3) AppendOnly StringTable

Stores string data. **Append-only**: new strings (or new versions of grown strings) are appended at the end. Existing entries are never moved, so no shifting is ever required.

- Each entry: `{ byteOffset, byteLength }` into a contiguous byte region.
- When a string grows, a new copy is appended and the reference in the DataTable is updated to point to the new location. The old copy becomes garbage (collected later or left as dead space).

### 4) ArrayTable

Stores array data. **Append-only**, same principle as the StringTable.

- Each entry: `{ elementOffset, elementCount }`.
- Arrays reserve **capacity padding** (extra slots beyond their length) so
  `push` appends in place without moving the array. When the padding is
  exhausted, the array is relocated with doubled capacity and the reference in
  the DataTable is updated. `pop` just decrements the length in place.

## Growth Strategy

- **Strings**: append a new copy to the append-only table, update the reference in the DataTable. No shifting of other data.
- **Arrays**: `push` writes into reserved capacity padding (O(1) amortized); only when the padding is exhausted is the array relocated with doubled capacity. `pop` decrements the length in place.
- **DataTable**: grows by appending new value slots at the end. Since references are fixed-size, existing entries don't move.
- **Index Table**: grows by adding new key entries.

## Data Type Constraints (from SPEC)

- Allowed: primitives (`number`, `string`, `boolean`), `bigint`, and arrays of these (mixed arrays allowed).
- Objects have a **fixed shape**: properties may not be added or removed after creation.
- Nested objects and arrays are supported, read lazily and mutated in place.
- `null` is supported as a value; `undefined` is not.

## API (unchanged from current)

```ts
const user = Shared<User>("user-1", { name: "Alice", age: 30, tags: ["a"] });
user.name; // getter → reads from DataTable → StringTable
user.name = "Bob"; // setter → appends to StringTable, updates DataTable ref
user.tags.push("b"); // appends to ArrayTable, updates DataTable ref
```

## Memory Layout Details

### Index Table entry (16 bytes)

```
[0..3]   key string offset (Int32) — into StringTable
[4..7]   key string length (Int32)
[8..11]  data offset (Int32) — into DataTable (changes on defragmentation)
[12..15] version cell (Int32) — version (bits 2..) + lock bits (bits 0..1)
```

### DataTable value slot (16 bytes)

```
[0..3]   type tag (Int32)
[4..7]   payload A
[8..11]  payload B
[12..15] payload C
```

| Tag | Type               | Payload                                                       |
| --- | ------------------ | ------------------------------------------------------------- |
| 0   | number             | float64 in A..B                                               |
| 1   | boolean            | A = 0/1                                                       |
| 2   | bigint             | int64 in A..B (values that fit in 64 bits)                    |
| 3   | string ref         | A = offset, B = byte length (StringTable)                     |
| 4   | array ref          | A = offset, B = count, C = capacity (ArrayTable)              |
| 5   | object block       | see below (only at the start of an object block)              |
| 6   | big bigint         | decimal string in the StringTable: A = offset, B = length     |
| 8   | inline string      | up to 11 UTF-8 bytes in A..C, length in the top 4 bits of C   |
| 9   | nested object      | A = DataTable offset of a nested object block                 |
| 10  | live key reference | A = Index Table index of another shared key (nested `Shared`) |
| 11  | null               | —                                                             |

Short strings (up to 11 bytes) are stored **inline** in the slot, so writing
them needs neither a heap allocation nor a StringTable write.

### Object block (DataTable)

```
[0..3]   type = 5
[4..7]   property count
[8..15]  reserved
then, per property: name ref (8 bytes: offset, length) + value slot (16 bytes)
```

The shape is fixed, so the offset of each property slot is stable (until
defragmentation moves the block) and a single property is read or written
without touching the others.

### StringTable

Raw UTF-8 bytes, append-only. A reference is `{ offset, byteLength }`. Strings
are interned per thread (LRU), so repeated strings reuse one copy.

### ArrayTable block

```
[0..3]   reserved
then     capacity * 16-byte value slots (count of them are in use)
```

## Synchronization

**Writes** to a key hold that key's **lock stripe**: one of 256 re-entrant
`Atomics`-based `Mutex`es (`src/mutex.ts`), selected by `keyIndex & 255`.
Writers to different keys run in parallel; writers to the same key (or to two
keys that share a stripe) are serialized, so read-modify-write sequences on one
value stay atomic. A cache miss on a **whole value** takes the same stripe.
**Reads are lock-free** as long as the value is unchanged: each key has a
version cell, and a per-thread read cache is valid while the version matches
(see V3 below). A miss on an **object property** is lock-free as well: only that
property's slot is decoded and cached per property.

The **global mutex** (`memory.lock`) remains for the rare structural work: key
creation (Index Table insert) and layout lookups. **Defragmentation** takes
every stripe and then the global mutex (`withAllLocks`), so it excludes all
writers. Lock order: stripes by ascending index, then the global mutex; code
holding a stripe may take the global mutex, never the reverse. A thread that
already holds the global mutex skips the stripe. Stripes and the global mutex
live in one `SharedArrayBuffer` (`lock.buffer`, one 64-byte cache line per
mutex), so sharing that buffer shares them all. A lock buffer that is too small
(a plain 12-byte `Mutex`) degrades to a single global lock.

A write that exhausts the memory budget releases its stripe, reclaims dead space
(which takes every stripe) and retries once; only the outermost lock level does
this.

#### Scaling on shared cache lines

In Bun/JavaScriptCore an `Atomics` access to a cache line that several workers
touch does not scale, even a plain `Atomics.load` (measured: one worker 600 M
loads/s, four workers 160 M/s in total), while atomics on a worker's own lines
and plain reads scale linearly. The write path therefore avoids atomics on
shared lines: "does this thread hold the global mutex?" is tracked per thread
instead of reading the lock word, and the layout version is read with a plain
load while a stripe is held (taking the lock is a full barrier). What remains
shared is the per-key version cell and stripe, which only the writers of that
key touch.

Each mutex occupies 12 bytes: cell 0 is the state
(**0** = free, **1** = held, **2** = held with waiters), cell 1 the owner
thread id, cell 2 the re-entrancy depth.

- `lock()` claims cell 0 with `Atomics.compareExchange` (0 → 1). On failure it
  marks the cell as "has waiters" (1 → 2) and falls back to a bounded
  `Atomics.wait`, so the thread sleeps instead of busy-spinning. The waiter
  re-checks the cell after marking it 2, so a release between the failed
  acquire and the `wait` is not lost.
- `unlock()` clears owner and depth, then releases the cell with
  `Atomics.exchange` (→ 0). It only calls `Atomics.notify` when the previous
  value was 2 (waiters present).
- **Re-entrancy** is recorded in the shared buffer itself (owner id + depth).
  The owner id is cleared before every release, so it equals the calling
  thread's id only while that thread really holds the lock. This also works
  when several `Mutex` instances wrap the same buffer in one thread. Legacy
  4-byte buffers fall back to per-instance depth tracking.
- **Bounded waits.** Every lock wait (`Mutex`, `RWLock`, the object seqlock,
  `waitForWritesToFinish`) times out (default 30 s, `setDefaultLockTimeout`)
  with a `LockTimeoutError`, so a crashed lock holder cannot hang other
  threads. The mutex records its owner, so `forceUnlock(ownerId)` can recover
  a lock held by a dead thread; the `MaintenanceCoordinator` does this
  automatically for a worker it unregisters (workers announce their owner id
  in the handshake). Seqlock cells and the standalone `RWLock` have no owner
  and rely on the timeout. On the browser main thread, where
  `Atomics.wait` is forbidden, waits fall back to a bounded busy-wait
  (`src/wait.ts`).

Logical operations (`readValue`, `writeValue`, `updateValue`, `mutateValue`)
each acquire the lock once, so read-modify-write sequences (array `push`,
property assignment, `update`) are atomic across workers.

`Notifier` (`src/notifier.ts`) wraps `Atomics.wait`/`Atomics.notify` for
user-facing worker-to-worker signaling.

### One SharedMemory per thread

A thread holds exactly one `SharedMemory`. The per-thread caches (read, offset,
layout, key index) are keyed by key name only, which is only sound with a single
memory. A second instance throws until the first is `dispose()`d (which also
clears the caches). A fresh memory (no `buffers`) can only be created on the
**main thread**; workers rebuild it from the main thread's buffers via `init()`
or `SharedMemory.fromBuffers()`.

### V2: Read/write lock (`RWLock`)

The single `Mutex` serializes _every_ operation, which is the price of
correctness (v1.0.1, review P1.1) but limits read-heavy workloads. V2 adds a
read/write lock (`src/rwlock.ts`) that relaxes that: **any number of readers**
may hold the lock concurrently, while **writers remain exclusive**.

The lock occupies one Int32 cell of a `SharedArrayBuffer` and encodes its
state in the low bits, leaving the high bits for a reader count:

```
bit 0 (0x00000001)  WRITER          a writer holds the lock exclusively
bit 1 (0x00000002)  WRITES_QUEUED   >=1 writer waiting; new readers back off
bit 2.. (0xFFFFFFFC) READER_COUNT   number of active readers (unit = 0b100)
```

- **Readers** acquire by atomically bumping `READER_COUNT`, so many can be
  active at once — but only while no writer holds the lock and no writer is
  queued (the `WRITES_QUEUED` bit prevents reader starvation of writers).
- **Writers** acquire only when the cell is entirely free, or at a hand-off
  when only the `WRITES_QUEUED` bit is set (a queued writer clearing it and
  setting `WRITER`). While waiting, a writer sets `WRITES_QUEUED` so new
  readers back off.
- **Release** wakes others only when a transition could unblock a party:
  after the last reader leaves, or after a writer releases with queued
  waiters.
- **Re-entrancy** is tracked per-thread (WeakMaps), mirroring `Mutex`. The same
  thread may acquire for reading repeatedly, for writing repeatedly, and may
  read while already holding the write lock — in the last case the read is a
  no-op because the thread already has exclusive access. A thread holding a
  read lock must _not_ upgrade to a write lock: that would deadlock against the
  thread's own read hold, so it throws.

(Since V3 there is no separate `rwLock` option: the `with*` methods use the
per-object version cell described below.)

### V3: Seqlock embedded in the version cell

Since v1.1.0 the read/write lock lives in **each object's version cell**
(`INDEX_VERSION_OFFSET` in the Index Table) instead of a separate `RWLock`
buffer. A single `Atomics.load` yields both the version (high bits) and the
lock state (low bits), so plain reads can check consistency without a mutex.

**Bit layout** (Int32):

```
bit 0 (0x00000001)  WRITER        withWriteLock is active (exclusive)
bit 1 (0x00000002)  READLOCK      withReadLock is active (one or more)
bits 2.. (0xFFFFFFFC) VERSION     logical version, bumped by 4 on each write
```

- `bumpVersion` adds `4` (VERSION_STEP), which increments the version but
  leaves lock bits untouched.
- `getVersion` returns `cell >>> 2`, stripping the lock bits transparently
  so existing callers and tests remain correct.
- **Ordinary writes use the same cell as a seqlock writer.** While a write
  holds its key's stripe it also sets the WRITER bit (`Atomics.or`), writes, and
  ends with one `Atomics.add(cell, 3)` that bumps the version and clears the bit
  (`SharedMemory.withKeyWrite`). Nested writes of the same key add no second
  mark, and the version bumps inside the write are skipped (`bumpVersion`
  recognises a cell this thread is writing). If the bit is already set by a
  user-level lock held by another thread, the write waits for it (so ordinary
  writes respect `withReadLock`/`withWriteLock`); if the lock is held by this
  very thread, the write just proceeds.
- **Cache hits** (`readProp`, `readValue`, property accessors): a **plain**
  (non-atomic) read of the cell. If the lock bits are clear and the version
  matches the cached one, the cached value is returned. An atomic load of a cache
  line that many workers read does not scale (readers of one hot key got slower
  with every worker), a plain load does; a stale read only delays seeing a
  change. JavaScriptCore did not hoist the load out of a tight loop in our tests
  (a change by another thread became visible after ~300 ms in a pure
  `while (o.x === 0)` loop), but the language does not guarantee that.
- **Lock-free decodes** (a property read that misses its cache): wait until the
  lock bits are clear (spin, then 1 ms sleeps: an ordinary write does not call
  `Atomics.notify`, a user-level lock does), remember the raw cell, decode the
  slot, then re-read the cell with an atomic RMW (`Atomics.add(cell, 0)`, a full
  barrier that keeps the data loads before it). If the cell changed, a write
  overlapped the read: decode again, and after a few attempts read once under the
  key's stripe. Without this a reader could return a string assembled from two
  writes (offset of one value with the length of another). Whole-value reads
  decode under the stripe instead and need no validation. Under a writer that
  writes the same key without pause a lock-free read cannot complete between two
  writes and ends up on the stripe path (a few µs).
- **`withWriteLock` / `withRWLock`**: acquire the WRITER bit via CAS, run the
  callback, then release — a single `Atomics.add(cell, 3)` bumps the version
  **and** clears the WRITER bit atomically, so waiting readers immediately
  observe the new version without a second atomic op. The callback receives the
  shared reference itself, so `self.prop = x` inside it writes shared memory.
- **`withReadLock`**: acquires the READLOCK bit via CAS, runs the callback,
  then releases with `Atomics.add(cell, -2)` (clears the bit, version
  untouched). While held, readers that have to decode and ordinary writes on
  this object wait.
- **Re-entrancy** (same thread): tracked via the `writeCellDepths` /
  `readCellDepths` maps (user-level locks) and the list of cells this thread is
  writing, all keyed by cell index. A thread never waits for lock bits it set
  itself (read-inside-write, a write inside its own lock, a lock requested from
  inside `update()`).

The old `SharedOptions.rwLock` field was removed because the cell-embedded
Seqlock makes a separate lock buffer unnecessary for `with*` methods. The
standalone `RWLock` class (`src/rwlock.ts`) remains for manual, worker-wide
locking that does not need per-object granularity.

```ts
const counter = Shared<number>("counter", 0);

// Exclusive read-modify-write (atomic across workers):
counter.withRWLock((c) => c.write(c.read() + 1));

// Held read lock: other threads' ordinary writes (and reads that have to
// decode) on this object wait until it is released.
const v = counter.withReadLock((c) => c.read());
```

## Hot-path notes (JIT)

Measured on Bun/JavaScriptCore; each point removed a visible share of a read or
write.

- **Resolve a chunk once.** A 16-byte slot is read or written through one
  `GrowableBuffer.viewAt(offset)`/`localOffset(offset)` pair, not four
  `getInt32`/`setInt32` calls that each re-resolve (and re-activate) the chunk.
  Slots that straddle a chunk boundary (defragmentation packs blocks back to
  back, ignoring chunk limits) use the per-field path (`slotLimit`).
- **Fixed-length chunk views** (created after the one-time growth of a chunk)
  are faster than length-tracking ones; everything that can still grow by
  another thread keeps a length-tracking view.
- **Little JS heap per key.** The reference of a key must be cheap, because a
  thread can hold many. The prototype of object refs, their methods (`read`,
  `write`, `update`, `with*Lock`, which find their key through a hidden
  `TARGET` property) and the Proxy handler for arrays/primitives are shared by
  all keys; per-key state is one `RefTarget` plus one small state object per
  property, and a property's write callback is only created on its first
  write. Sharing the prototype also lets all objects of one shape share their
  hidden classes (a prototype per key gave each key six Structures with
  property tables), which makes reads across many keys faster. `ref.read()` on
  a Proxy answers in one trap call: its function is created per target on first
  use (a shared method would need a second trap to find the target and made
  that read 2.5× slower). The registry of wrappers is weak (`WeakRef`), and a
  `FinalizationRegistry` callback removes the read/index/offset/layout cache
  entries of a collected wrapper.
- **No allocation per operation.** No closure per write (the lock body is
  created once; the value travels through saved/restored variables), no
  `ValueSlot`/`Uint8Array`/`Map` on common reads, no `TextEncoder` or
  `TextDecoder` for short ASCII strings, no regular expression for array keys.
- **Few atomics.** A per-key lock is 4 atomic operations when uncontended
  (`StripeLock`); atomics on cache lines shared by many workers do not scale,
  so the write path avoids them (see Synchronization).
- **Cache-miss reads read what they need.** Property names come from the cached
  layout, a primitive is decoded straight from its slot, and the first miss for
  an array element reads only that element.
- **Type feedback is shared.** The JIT specializes on the types it has seen at a
  site. A process that reads and writes many value types through the same
  functions (the micro benchmarks do) runs slower per operation than one that
  uses a single type; compare numbers only between runs of the same shape.

## Open Questions

- **Index Table keying**: Entries are stored in insertion order; name lookup
  uses a per-instance `Map` filled incrementally from the table (O(1)
  amortized). A hash table in shared memory would only be needed to avoid
  decoding every key once per thread.
- **Dead space in append-only tables**: Overwritten values leave dead blocks
  (the `free*` functions are no-ops). They are reclaimed by defragmentation,
  which the `MaintenanceCoordinator` runs when a table fills up (default 80 %).
  A write that exhausts the budget does not wait for that timer: it runs
  `reclaimHook` and retries once. On the main thread the hook is the
  coordinator's full defragmentation (releases unused chunks and broadcasts the
  new chunk lists); on every other thread it is `reclaimInPlace()`, which
  compacts without replacing chunks, so no broadcast is needed.
- **Write scalability**: writes are striped per key, so independent writers
  scale; writers of the same key are serialized. Defragmentation still stops
  all writers (it takes every stripe). Neighbouring keys share cache lines
  (16-byte Index Table entries, adjacent object blocks); padding them would
  trade memory for less false sharing.
- **Buffer sizing/growth**: DataTable, StringTable, and ArrayTable are backed
  by a chunked `GrowableBuffer`: all chunks are pre-allocated at construction
  (4 bytes each, `maxByteLength = chunkSize`, 32 MiB default) and activated on
  first access via `SharedArrayBuffer.grow()`. Because `grow()` is visible
  across all workers, activation needs no broadcast. The Index Table is the
  exception: it uses a single growable `SharedArrayBuffer` (capped at 4 GiB).
  `maxTotalBytes` caps the combined physical size of the three chunked tables
  via an atomic `SharedBudget` counter shared across workers, reserving memory
  before each chunk growth. Configurable via `SharedOptions`. Size limits are
  enforced regardless of the configured values: `chunkSize` is at least 4 MiB,
  `maxTotalBytes`/`maxByteLength` are at least 32 MiB, and `chunkSize` is
  raised as needed so no table needs more than 1024 chunks.
- **Multi-chunk strings/arrays**: Strings and arrays are stored contiguously in their append-only tables; a reference stores the offset and length/count. Growth appends new data and updates the reference (no shifting of existing data).
