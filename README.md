<div align="center">

# 🧠 bun-shared-memory

**Share data between Bun workers/threads using `SharedArrayBuffer`** — zero-copy, 4-buffer architecture, Atomics-based synchronization.

[![npm version](https://img.shields.io/npm/v/bun-shared-memory?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/bun-shared-memory)
[![npm downloads](https://img.shields.io/npm/dm/bun-shared-memory?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/bun-shared-memory)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/bun-shared-memory?style=for-the-badge&color=blueviolet)](https://bundlephobia.com/package/bun-shared-memory)

[![GitHub stars](https://img.shields.io/github/stars/Kapsonfire/bun-shared-memory?style=for-the-badge&logo=github&color=181717)](https://github.com/Kapsonfire/bun-shared-memory)
[![GitHub forks](https://img.shields.io/github/forks/Kapsonfire/bun-shared-memory?style=for-the-badge&logo=github&color=181717)](https://github.com/Kapsonfire/bun-shared-memory)
[![GitHub issues](https://img.shields.io/github/issues/Kapsonfire/bun-shared-memory?style=for-the-badge&logo=github&color=181717)](https://github.com/Kapsonfire/bun-shared-memory/issues)
[![GitHub license](https://img.shields.io/github/license/Kapsonfire/bun-shared-memory?style=for-the-badge&color=green)](https://github.com/Kapsonfire/bun-shared-memory/blob/main/LICENSE)

[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.4.0-black?style=for-the-badge&logo=bun&color=14151a)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue?style=for-the-badge&logo=typescript&color=3178c6)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen?style=for-the-badge&logo=checkmarx)](https://github.com/Kapsonfire/bun-shared-memory/actions)

</div>

---

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

> **Requires Bun ≥ 1.4.0.** The worker integration (M4) relies on the
> `process.on("worker")` handshake, which only works reliably from Bun 1.4.0
> onward. Core shared-memory operations (including `SharedArrayBuffer.grow()`)
> work on earlier versions, but the automatic worker buffer-sharing does not.

## ✨ Features

- 🚀 **Zero-copy** shared memory between workers/threads via `SharedArrayBuffer`
- 🧩 **4-buffer architecture** — Index Table, DataTable, append-only StringTable, ArrayTable
- 🔒 **Atomics-based synchronization** — re-entrant `Mutex` + `Notifier`
- ⚡ **Read & offset caches** — lock-free fast path, cross-worker invalidation via version cells
- 🧹 **Reference counting & defragmentation** — automatic memory reclamation
- 🪄 **Proxy-based API** — `Shared()` with direct getter/setter access
- 🧵 **Automatic worker integration** — no manual buffer serialization

## 📦 Install

```sh
bun add bun-shared-memory
```

See [SPEC.md](./SPEC.md) for the full specification.

## Status

✅ **M3 — Synchronization**: `Atomics`-based locking (`Mutex`) and notifications (`Notifier`) between workers, integrated into all shared-memory operations.

✅ **Read cache**: reads are cached per worker and invalidated cross-worker via a per-key version counter.

✅ **Reference counting & defragmentation**: workers acquire/release references to shared objects/arrays (released on GC), the main thread tracks which worker holds what, and a defragmentation pass reclaims dead space when free space is low.

✅ **M4 — Worker integration**: a worker can simply call `Shared()` and automatically share the same buffers as the main thread. Both sides call `init()` — the main thread answers buffer requests, each worker requests the shared buffers — no manual buffer serialization needed.

## 📊 Stats

| | |
|---|---|
| **Version** | [![npm version](https://img.shields.io/npm/v/bun-shared-memory?color=cb3837)](https://www.npmjs.com/package/bun-shared-memory) |
| **Downloads / month** | [![npm downloads](https://img.shields.io/npm/dm/bun-shared-memory?color=cb3837)](https://www.npmjs.com/package/bun-shared-memory) |
| **Stars** | [![GitHub stars](https://img.shields.io/github/stars/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory) |
| **Forks** | [![GitHub forks](https://img.shields.io/github/forks/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory) |
| **Open issues** | [![GitHub issues](https://img.shields.io/github/issues/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory/issues) |
| **Open PRs** | [![GitHub pull requests](https://img.shields.io/github/issues-pr/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory/pulls) |
| **License** | [![License](https://img.shields.io/github/license/Kapsonfire/bun-shared-memory?color=green)](https://github.com/Kapsonfire/bun-shared-memory/blob/main/LICENSE) |
| **Language** | [![TypeScript](https://img.shields.io/badge/TypeScript-7-blue?color=3178c6)](https://www.typescriptlang.org) |

## Data Types

- **Allowed**: primitives (`number`, `string`, `boolean`), `bigint`, and arrays of these (mixed arrays allowed).
- **BigInts** of any size are supported: values that fit in 64 bits are stored as a fast int64 slot; larger values are stored as their decimal string in the StringTable.
- **Objects** have a **fixed shape**: once created, properties may not be added or removed — only their values can change.
- **Not allowed**: nested objects, nested arrays, `null`, `undefined`.

## Usage

Always call `init()` first — on both the main thread and in every worker. It
sets up the shared-memory handshake and (optionally) configures the buffers.

```ts
import { Shared, init } from "bun-shared-memory";

// Main thread: call init() once at startup. It creates the shared memory
// (with the given buffer sizes) and answers buffer requests from workers.
await init({ initialSize: 64 * 1024, maxByteLength: 4 * 1024 * 1024 * 1024 });

// Get a wrapper to a named value in shared memory.
// If it doesn't exist, create it with the provided initial value.
const user = Shared<User>("user-1", { name: "Alice", age: 30, tags: ["a"] });

// Access object properties directly via getters/setters
user.name; // "Alice"
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

In a worker, `await init()` requests the shared buffers from the main thread
and reconstructs the same memory, so `Shared()` reads/writes the same data as
the main thread. See [Worker integration](#worker-integration) below.

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
import { Mutex } from "bun-shared-memory";

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
import { Notifier } from "bun-shared-memory";

const notifier = new Notifier();
// pass notifier.buffer to other workers, then:
notifier.wait(); // block until notified
notifier.notify(1); // wake one waiting worker
```

## Reference counting & memory reclamation

The shared buffers are append-only, so dead space (overwritten strings,
abandoned array blocks, replaced objects) is never reclaimed on its own. A
reference-counting system tracks which workers hold references to which
objects/arrays, and a **defragmentation** pass reclaims memory when free space
runs low.

When you use the worker integration (`init()`), this is wired up automatically:
`init()` starts a `RefCountCoordinator` on the main thread (auto-maintenance +
auto-registration of workers) and a `RefCountTracker` in each worker, so
`read()` acquires references that are released on GC and dead space is
defragmented — no manual setup needed.

```ts
import { Shared, init } from "bun-shared-memory";

// Main thread: init() starts the coordinator automatically.
await init();
const user = Shared("user-1", { name: "Alice" });
const copy = user.read(); // acquires a ref; released when `copy` is GC'd
```

You can also wire it up manually (e.g. when not using `init()`):

```ts
import {
  SharedMemory,
  RefCountCoordinator,
  RefCountTracker,
  RefCountBuffer,
} from "bun-shared-memory";

// Main thread: coordinate refcounts and auto-register workers.
const mem = new SharedMemory();
const coord = new RefCountCoordinator(mem); // auto-maintenance starts automatically
coord.autoRegister(); // track workers via process.on("worker")
// The coordinator periodically drains acquire/release events and defragments
// when free space runs low — no manual calls needed.

// Worker: track references acquired by read().
const tracker = new RefCountTracker(new RefCountBuffer(refBuf), workerId);
const user = Shared(
  "user-1",
  { name: "Alice" },
  { memory: mem, refCount: tracker },
);
const copy = user.read(); // acquires a ref; released when `copy` is GC'd
```

See [REFCOUNT.md](./REFCOUNT.md) for the full design.

## Worker integration

A worker can simply call `Shared()` and automatically share the same buffers
as the main thread — no manual buffer serialization needed. Both sides call
`init()` to set up the handshake: the main thread answers buffer requests from
workers, and each worker requests the shared buffers from the main thread.

```ts
// main.ts
import { Shared, init } from "bun-shared-memory";

// Always call init() first. It creates the shared memory (with the given
// buffer sizes) and answers buffer requests from every new worker.
await init({ initialSize: 64 * 1024, maxByteLength: 4 * 1024 * 1024 * 1024 });

const user = Shared("user-1", { name: "Alice", age: 30 });
```

```ts
// worker.ts
import { Shared, init, onMessage } from "bun-shared-memory";

await init(); // request the shared buffers from the main thread

// Register your own message handler via onMessage(); messages are buffered
// until the buffers have arrived.
onMessage((e) => {
  const user = Shared("user-1", { name: "x" }); // reads the main thread's value
  self.postMessage(user.read());
});
```

`init()` is safe to call on both sides: in the main thread it registers the
buffer-request listener and starts the refcount coordinator (auto-maintenance

- worker auto-registration), and in a worker it performs the request/response
  handshake, reconstructs the shared buffers, and creates a refcount tracker —
  so reference counting works automatically. `Shared()` never overwrites a value
  that already exists in shared memory, so a worker reading a key created by the
  main thread gets the existing value rather than its own initial value.

> **Note:** a worker must call `await init()` before using `Shared()`. Calling
> `Shared()` in a worker without `init()` throws an error rather than silently
> creating a separate, unshared memory.

The coordinator's maintenance timer is unref'd, so it does not keep the
process alive — the process exits naturally once no other work is pending
(e.g. after the last worker closes). You don't need to call `stopInit()` or
`process.exit()` to terminate.

A complete runnable example is in [`examples/worker/`](examples/worker/).

## Memory budget

Shared memory is split across several growable `SharedArrayBuffer`s (the
index, data, string, and array tables; each key's version counter lives in its
index entry). A single `SharedArrayBuffer` can be at most **4 GiB**. By default
each buffer grows independently up to its own `maxByteLength`, so the _total_
memory can be several times that.

Configure the buffers when calling `init()` — pass `initialSize` (each
buffer's starting size, avoiding a grow on first use) and `maxByteLength`
(each buffer's cap). To cap the **total** memory across all buffers, pass
`maxTotalBytes`:

```ts
import { init } from "bun-shared-memory";

// Each buffer starts at 64 KiB and grows up to 4 GiB; the sum of all buffers'
// physical sizes is additionally capped at 4 GiB (maxTotalBytes).
await init({
  initialSize: 64 * 1024,
  maxByteLength: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
});
```

`maxTotalBytes` caps the **sum** of all buffers' physical sizes, so the total
stays within the budget. If a write would exceed the budget, a `RangeError` is
thrown. Without `maxTotalBytes`, each buffer simply grows up to its own
`maxByteLength`.

The budget is shared dynamically — buffers grow as needed, but only while the
sum of all buffers stays within `maxTotalBytes`. If a write would exceed the
budget, a `RangeError` is thrown.

## Array capacity

By default an array is stored with exactly as many slots as it has elements,
so the first `push` must relocate the array (with doubled capacity) to make
room. To avoid that, reserve extra capacity up front with `arrayCapacity`:

```ts
import { Shared } from "bun-shared-memory";

// Reserve 100 slots so the first ~90 pushes append in place without moving.
const arr = Shared<number[]>("arr-cap", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], {
  arrayCapacity: 100,
});
```

`arrayCapacity` is the initial capacity (in elements) reserved for arrays when
they are first stored. `push` appends in place until the capacity is
exhausted, then the array is relocated with doubled capacity. It defaults to
the array's length.

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
- **Arrays**: `number[]`, `string[]`, `boolean[]`, `bigint[]`, `mixed[]` (index read, index write)
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

## 🤝 Contributing

Contributions are welcome! Please open an issue or pull request.

- 🐛 [Report a bug](https://github.com/Kapsonfire/bun-shared-memory/issues/new?labels=bug)
- 💡 [Request a feature](https://github.com/Kapsonfire/bun-shared-memory/issues/new?labels=enhancement)
- 📖 [Browse open issues](https://github.com/Kapsonfire/bun-shared-memory/issues)
- 🔀 [Open a pull request](https://github.com/Kapsonfire/bun-shared-memory/pulls)

## 📄 License

[MIT](./LICENSE) © [Kapsonfire](https://github.com/Kapsonfire)
