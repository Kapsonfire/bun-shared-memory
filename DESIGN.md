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

- A fixed-size table of entries.
- Each entry: `{ keyHash, dataOffset }` (or a hash map / open-addressing scheme).
- Used by `Shared(key, ...)` to look up whether a value already exists and where its data lives.

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

### Index Table entry (fixed size)

```
[0..3]   key hash (Int32)
[4..7]   data offset (Int32) — into DataTable
```

### DataTable value slot (fixed size)

```
[0..3]   type tag (Int32): 0=primitive, 1=string-ref, 2=array-ref, 3=object
[4..7]   payload / reference
[8..11]  payload / reference (for objects: property count; for strings/arrays: length)
```

### StringTable entry

```
[0..3]   byte offset (Int32) — into string byte region
[4..7]   byte length (Int32)
```

### ArrayTable entry

```
[0..3]   element offset (Int32) — into element region
[4..7]   element count (Int32)
```

## Synchronization

All shared-memory operations are protected by a re-entrant `Atomics`-based
`Mutex` (`src/mutex.ts`). The mutex uses a single Int32 cell in a
`SharedArrayBuffer` that encodes the lock state: **0** = free, **1** = held
(no waiters), **2** = held (waiters present).

- `lock()` claims the cell with `Atomics.compareExchange` (0 → 1). On failure
  it marks the cell as "has waiters" (1 → 2) and falls back to `Atomics.wait`
  so the thread sleeps instead of busy-spinning while the lock is held
  elsewhere. The waiter re-checks the cell after marking it 2, so a release
  between the failed acquire and the `wait` is not lost (the `wait` returns
  immediately with "not-equal" and the loop retries).
- `unlock()` releases the cell with `Atomics.exchange` (→ 0). It only calls
  `Atomics.notify` when the previous value was 2 (waiters present), waking all
  of them; in the uncontended case (cell was 1) the expensive `notify` is
  skipped entirely.
- Re-entrancy is tracked per-thread via a module-level depth map, so a locked
  operation may safely call another locked operation (e.g. `updateValue`
  calling `readValue`/`writeValue`).

Logical operations (`readValue`, `writeValue`, `updateValue`, `mutateValue`)
each acquire the lock once, so read-modify-write sequences (array `push`,
property assignment, `update`) are atomic across workers.

`Notifier` (`src/notifier.ts`) wraps `Atomics.wait`/`Atomics.notify` for
user-facing worker-to-worker signaling.

## Open Questions

- **Index Table keying**: Currently a linear scan comparing stored key strings directly (O(n) lookup). A hash table could improve lookup for many keys — future optimization.
- **Dead space in append-only tables**: Left as-is (no GC). Reclaiming dead space is a future optimization.
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
