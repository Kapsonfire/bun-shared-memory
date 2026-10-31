# REFCOUNT.md — Reference Counting & Memory Reclamation

## Overview

The 4-buffer architecture is **append-only**: the DataTable, StringTable, and
ArrayTable only grow, and dead space (from overwritten strings/arrays or
deleted values) is never reclaimed. This document describes a reference
counting system that tracks which workers hold references to which objects and
arrays, and a **defragmentation** pass that reclaims memory when the buffers
run low on free space.

## Goals

- Track, per object/array in the DataTable, how many workers hold a reference.
- Reclaim memory when no worker references an object/array anymore.
- Handle worker crashes: a crashed worker cannot send a release event, so its
  references must be released by the main thread when the worker closes.
- Defragment all tables (DataTable, ArrayTable, StringTable) when free space
  drops below a threshold (e.g. < 10%), not eagerly on every release.

## Non-Goals

- Reclaiming memory eagerly on every release (defragmentation is deferred until
  memory is scarce).
- Reference counting for primitives (they are stored inline and cost nothing).
- Cross-process sharing (threads within a single process only).

## Architecture

### Roles

- **Main thread**: owns the global reference table. Tracks which worker holds
  a reference to which object/array. Runs the defragmentation pass.
- **Worker**: tracks its own local references (which objects/arrays it has
  acquired). Reports acquire/release events to the main thread. Sends a
  heartbeat so the main thread can detect crashes.

### Reference lifecycle

A reference is **acquired** when a worker calls `read()` on a shared value
(returning a JS object/array). It is **released** when the returned JS object
is garbage-collected (via `FinalizationRegistry`), or when the worker closes.

```
Worker                          Main thread
  │ read() → acquire ref          │
  │ ── acquire(objectId) ────────▶│  globalRefs[objectId][workerId]++
  │ ...                           │
  │ GC of returned object         │
  │ ── release(objectId) ────────▶│  globalRefs[objectId][workerId]--
  │                               │  if all workers released → free
  │ worker.close()                │
  │ ── (close event) ────────────▶│  release all refs of this worker
```

### Communication channel

Workers and the main thread communicate over a dedicated **RefCount
SharedArrayBuffer** (a 5th buffer). It contains:

- A **message queue** (ring buffer) for acquire/release events from workers to
  the main thread.
- A **heartbeat table**: one cell per worker, updated periodically by the
  worker; the main thread reads it to detect crashes.
- A **global refcount table**: one cell per object/array, holding the total
  number of worker references.

The main thread owns the global table and the defragmentation pass. Workers
only append events to the queue and update their heartbeat.

### Worker crash handling

A worker that crashes cannot send a release event. The main thread detects this
via the worker's `close` event (Bun: `worker.on("close", ...)`; Node:
`worker.on("exit", ...)`), which fires on both normal exit and crash. On close,
the main thread releases **all** references held by that worker.

A heartbeat is a secondary safety net: if a worker stops heartbeating without a
close event (e.g. a hung worker), the main thread can reclaim its references
after a timeout.

## Data structures

### Object/Array identity

Every object and array in the DataTable gets a stable **objectId** (a monotonic
counter). The objectId is stored in the object/array header so the refcount
table can be keyed by it. The DataTable offset is *not* used as identity because
it changes during defragmentation.

### Global refcount table (main thread)

```
objectId → { totalRefs: Int32, perWorker: Map<workerId, count> }
```

- `totalRefs` is the sum of all worker reference counts.
- When `totalRefs` reaches 0, the object/array is a candidate for reclamation.

### Local refcount (worker)

Each worker keeps a `FinalizationRegistry` mapping a returned JS object/array
to its `objectId`. When the JS object is GC'd, the registry callback sends a
`release(objectId)` event to the main thread.

## Defragmentation

Defragmentation is triggered by the main thread when any table's free space
drops below a threshold (default: < 10% of `maxByteLength`). It is **not** run
eagerly on every release.

### Algorithm

1. **Mark**: Walk the live object graph from the Index Table. Every object,
   array, and string reachable from a live key (or from a live object/array
   that is still referenced) is marked as live. Objects/arrays with
   `totalRefs == 0` and no live key are dead.

2. **Compact DataTable**: Move live object blocks to the front, updating:
   - the Index Table's `dataOffset` for top-level keys,
   - the object's own `objectId` → new offset mapping (for the refcount table).

3. **Compact ArrayTable**: Move live array slots to the front, updating every
   array-ref slot in the DataTable that points to them.

4. **Compact StringTable**: Move live string bytes to the front, updating every
   string-ref slot in the DataTable and ArrayTable, and the StringTable refs in
   the Index Table (key strings) and object property names.

5. **Update caches**: After compaction, all per-worker caches that hold offsets
   (indexCache, layoutCache, propCache, readCache, internCache) are invalidated
   (or their offsets remapped). The main thread bumps a global **layout
   version** cell that workers check before trusting cached offsets.

### Correctness notes

- Compaction runs under the shared mutex, so no worker can read/write during
  the move.
- All references are updated in a single pass before the mutex is released, so
  workers never observe a half-moved state.
- The `objectId` is stable across compaction (only the offset changes), so the
  refcount table stays valid.

## API

```ts
// Worker: acquire a reference when reading
const user = Shared<User>("user-1", { name: "Alice" });
const copy = user.read();   // acquires a ref; released when `copy` is GC'd

// Main thread: register a worker and its close handler
const coordinator = new RefCountCoordinator(memory);
coordinator.registerWorker(worker);  // attaches close listener, frees refs on close
coordinator.maybeDefragment();       // runs defragmentation if free space < 10%
```

## Open Questions

- **String interning vs. defragmentation**: the interning cache holds
  StringTable refs. After compaction these refs change, so the cache must be
  invalidated (via the layout version) or remapped.
- **Threshold tuning**: the 10% free-space threshold is a default; it should be
  configurable.
- **Heartbeat interval**: how often workers heartbeat, and the timeout before a
  silent worker's refs are reclaimed.
