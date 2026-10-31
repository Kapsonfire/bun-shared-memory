# shared-memory

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

See [SPEC.md](./SPEC.md) for the full specification.

## Status

✅ **M3 — Synchronization**: `Atomics`-based locking (`Mutex`) and notifications (`Notifier`) between workers, integrated into all shared-memory operations.

✅ **Read cache**: reads are cached per worker and invalidated cross-worker via a per-key version counter.

✅ **Reference counting & defragmentation**: workers acquire/release references to shared objects/arrays (released on GC), the main thread tracks which worker holds what, and a defragmentation pass reclaims dead space when free space is low.

✅ **M4 — Worker integration**: a worker can simply call `Shared()` and automatically share the same buffers as the main thread. Both sides call `init()` — the main thread answers buffer requests, each worker requests the shared buffers — no manual buffer serialization needed.

## Data Types

- **Allowed**: primitives (`number`, `string`, `boolean`), `bigint`, and arrays of these (mixed arrays allowed).
- **BigInts** of any size are supported: values that fit in 64 bits are stored as a fast int64 slot; larger values are stored as their decimal string in the StringTable.
- **Objects** have a **fixed shape**: once created, properties may not be added or removed — only their values can change.
- **Not allowed**: nested objects, nested arrays, `null`, `undefined`.

## Usage

```ts
import { Shared } from "shared-memory";

// Get a wrapper to a named value in shared memory.
// If it doesn't exist, create it with the provided initial value.
const user = Shared<User>("user-1", { name: "Alice", age: 30, tags: ["a"] });

// Access object properties directly via getters/setters
user.name;        // "Alice"
user.name = "Bob"; // writes to shared memory
user.age = 31;

// Arrays are proxied too: index access and mutating methods work
user.tags.push("b");
user.tags[0] = "x";
user.tags.pop();

// Top-level arrays work the same way
const arr = Shared<number[]>("arr-1", [1, 2, 3]);
arr.push(4);
arr[0] = 99;

// Primitives use read()/write()/update()
const counter = Shared<number>("counter-1", 0);
counter.write(42);
counter.update((n) => n + 1);

// Or create it with a loader function (sync or async)
const user2 = await Shared<User>("user-2", async () => {
  return await fetchUser();
});
```

## Synchronization

All shared-memory reads and writes are protected by an `Atomics`-based mutex, so concurrent access from multiple workers is safe.

### Read cache

Reads are cached per worker to avoid re-decoding the value on every access.
Each key has a version cell (an `Int32`) in shared memory that is incremented
on every write. A read does a single lock-free `Atomics.load` on the version
cell; if it matches the cached version, the cached value is returned without
taking the lock or decoding. Because the version cell is shared, a write in
any worker invalidates the cache in every other worker automatically.

`read()` returns a copy, so mutating the returned object cannot corrupt the
cache. Property access through the proxy (e.g. `user.name`) reads from the
cache directly.

### Offset cache

Because object properties may not be added or removed, an object's layout
(total DataTable offset + each property's slot offset) is static for the
lifetime of the object. The layout is built once (under the lock) and cached
per worker, so a property read decodes only the requested slot instead of the
whole object. The decoded property value is cached per property and
invalidated by the same per-key version cell, so repeated reads of the same
property are cheap. If a future GC/defragmentation moves an object block, the
layout cache must be invalidated (e.g. via a layout version cell).

### Mutex

A re-entrant cross-worker mutex. Share the same buffer across workers.

```ts
import { Mutex } from "shared-memory";

const mutex = new Mutex();
// pass mutex.buffer to other workers, then:
mutex.lock();
try {
  // critical section
} finally {
  mutex.unlock();
}
// or
mutex.withLock(() => {
  // critical section
});
```

### Notifier

A cross-worker notification primitive built on `Atomics.wait`/`Atomics.notify`.

```ts
import { Notifier } from "shared-memory";

const notifier = new Notifier();
// pass notifier.buffer to other workers, then:
notifier.wait();      // block until notified
notifier.notify(1);   // wake one waiting worker
```

## Reference counting & memory reclamation

The shared buffers are append-only, so dead space (overwritten strings,
abandoned array blocks, replaced objects) is never reclaimed on its own. A
reference-counting system tracks which workers hold references to which
objects/arrays, and a **defragmentation** pass reclaims memory when free space
runs low.

```ts
import { SharedMemory, RefCountCoordinator, RefCountTracker, RefCountBuffer } from "shared-memory";

// Main thread: coordinate refcounts and auto-register workers.
const mem = new SharedMemory();
const coord = new RefCountCoordinator(mem);  // auto-maintenance starts automatically
coord.autoRegister();          // track workers via process.on("worker")
// The coordinator periodically drains acquire/release events and defragments
// when free space runs low — no manual calls needed.

// Worker: track references acquired by read().
const tracker = new RefCountTracker(new RefCountBuffer(refBuf), workerId);
const user = Shared("user-1", { name: "Alice" }, { memory: mem, refCount: tracker });
const copy = user.read();      // acquires a ref; released when `copy` is GC'd
```

See [REFCOUNT.md](./REFCOUNT.md) for the full design.

## Worker integration

A worker can simply call `Shared()` and automatically share the same buffers
as the main thread — no manual buffer serialization needed. Both sides call
`init()` to set up the handshake: the main thread answers buffer requests from
workers, and each worker requests the shared buffers from the main thread.

```ts
// main.ts
import { Shared, init } from "shared-memory";

const user = Shared("user-1", { name: "Alice", age: 30 });
init();   // answer buffer requests from every new worker
```

```ts
// worker.ts
import { Shared, init, onMessage } from "shared-memory";

await init();   // request the shared buffers from the main thread

// Register your own message handler via onMessage(); messages are buffered
// until the buffers have arrived.
onMessage((e) => {
  const user = Shared("user-1", { name: "x" });  // reads the main thread's value
  self.postMessage(user.read());
});
```

`init()` is safe to call on both sides: in the main thread it registers the
buffer-request listener, and in a worker it performs the request/response
handshake and resolves once the buffers have arrived. `Shared()` never
overwrites a value that already exists in shared memory, so a worker reading a
key created by the main thread gets the existing value rather than its own
initial value.

## Development

```bash
bun install        # install dependencies
bun run typecheck  # type check (bun check)
bun test           # run tests
bun fmt            # format code
bun run bench      # run benchmarks
```

## Benchmarks

`bun run bench` compares shared-memory access against native JS access for
every supported data type and its arrays:

- **Primitives**: `number`, `string`, `boolean`, `bigint` (read + write)
- **Arrays**: `number[]`, `string[]`, `boolean[]`, `bigint[]`, `mixed[]` (index read, index write, push)
- **Objects**: property read/write and array-property access

Each benchmark reports ops/sec for the native and shared paths, plus the
relative slowdown. Results are in `bench/`.

With the read cache and offset cache, **reads** are typically 5–12× slower than
native (the remaining cost is the proxy dispatch). **Writes** are slower because
they must serialize, write, and bump the version cell. Object property and array
index writes are O(1) in-place updates (only the affected slot is written).
Array `push`/`pop` are O(1) amortized in-place operations: arrays reserve
capacity padding in the ArrayTable, `push` writes into the padding until it is
exhausted (then the array is relocated with doubled capacity), and `pop` just
decrements the length.

**String interning**: repeated writes of the same string reuse a cached
StringTable reference instead of re-encoding and re-copying the bytes. The
per-worker LRU cache grows dynamically (configurable via `internCapacity` /
`internMax` on `SharedMemory`) and evicts least-recently-used entries once it
reaches capacity. Because the StringTable is append-only, cached references stay
valid for the lifetime of the buffer.
