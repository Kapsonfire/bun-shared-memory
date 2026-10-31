# shared-memory

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

See [SPEC.md](./SPEC.md) for the full specification.

## Status

🚧 **M3 — Synchronization**: `Atomics`-based locking (`Mutex`) and notifications (`Notifier`) between workers, integrated into all shared-memory operations.

✅ **Read cache**: reads are cached per worker and invalidated cross-worker via a per-key version counter.

## Data Types

- **Allowed**: primitives (`number`, `string`, `boolean`), `bigint`, and arrays of these (mixed arrays allowed).
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
native (the remaining cost is the proxy dispatch). **Writes** are much slower
because they must serialize, write, and bump the version cell; array `push`
re-encodes the whole array each time.
