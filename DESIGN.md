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

- **Object**: a fixed set of property slots. Each slot holds either a primitive value directly, or a *reference* to a string/array in tables 3/4.
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
- When an array grows (e.g. `push`), a new copy is appended and the reference in the DataTable is updated.

## Growth Strategy

- **Strings/arrays**: append a new copy to the append-only table, update the reference in the DataTable. No shifting of other data.
- **DataTable**: grows by appending new value slots at the end. Since references are fixed-size, existing entries don't move.
- **Index Table**: grows by adding new key entries.

## Data Type Constraints (from SPEC)

- Allowed: primitives (`number`, `string`, `boolean`), `bigint`, and arrays of these (mixed arrays allowed).
- Objects have a **fixed shape**: properties may not be added or removed after creation.
- Not allowed: nested objects, nested arrays, `null`, `undefined`.

## API (unchanged from current)

```ts
const user = Shared<User>("user-1", { name: "Alice", age: 30, tags: ["a"] });
user.name;          // getter → reads from DataTable → StringTable
user.name = "Bob";  // setter → appends to StringTable, updates DataTable ref
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

## Open Questions

- **Index Table keying**: Currently a linear scan comparing stored key strings directly (O(n) lookup). A hash table could improve lookup for many keys — future optimization.
- **Dead space in append-only tables**: Left as-is (no GC). Reclaiming dead space is a future optimization.
- **Buffer sizing/growth**: Each buffer starts at `initialSize` (default 1024 bytes) and doubles via `GrowableBuffer.ensureCapacity` up to `maxByteLength` (default 64 MiB). Configurable via `SharedOptions`.
- **Multi-chunk strings/arrays**: Strings and arrays are stored contiguously in their append-only tables; a reference stores the offset and length/count. Growth appends new data and updates the reference (no shifting of existing data).
