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

## 📈 Real-world benchmark

`bun run bench:real` compares four methodologies for serving a "get user"
request through an [Elysia](https://elysiajs.com) mini API. Requests are built
by hand and passed directly to `app.fetch()` (no HTTP server); each methodology
is benchmarked sequentially with 4 workers. See
[`bench/real-world/README.md`](bench/real-world/README.md) for setup.

Measured on Linux (Core Ultra 7 265K, Bun 1.4.4, 100,000 requests per
methodology, sorted by speed; MySQL/Redis ran in Docker, once over TCP and once
over a Unix socket; each methodology is the minimum over several runs × samples
to filter CPU-contention noise; the full log is
`benchlogs/1794424149-9bbbd34-real.md`):

| Methodology | Transport | Requests | Elapsed (ms) | req/s     | vs. shared   |
| ----------- | --------- | -------- | ------------ | --------- | ------------ |
| `shared`    | —         | 100,000  | 15           | 6,762,549 | —            |
| `sqlite`    | —         | 100,000  | 75           | 1,329,665 | 5.1× slower  |
| `redis`     | socket    | 100,000  | 267          | 374,813   | 18.0× slower |
| `mysql`     | socket    | 100,000  | 394          | 254,053   | 26.6× slower |
| `redis`     | tcp       | 100,000  | 634          | 157,773   | 42.9× slower |
| `mysql`     | tcp       | 100,000  | 950          | 105,244   | 64.3× slower |

Shared memory is the fastest by a wide margin: ~5× faster than a live SQLite
read, ~18–27× faster than MySQL/Redis over a Unix socket and ~40–65× faster over
TCP. The database numbers depend heavily on the machine and on how the
containers are networked; treat them as an order of magnitude, not a constant.

## ✨ Features

- 🚀 **Zero-copy** shared memory between workers/threads via `SharedArrayBuffer`
- 🧩 **4-buffer architecture** — Index Table, DataTable, append-only StringTable, ArrayTable
- 🔒 **Atomics-based synchronization** — per-key write locks (256 lock stripes, parallel writers on different keys), re-entrant `Mutex`, `Notifier`
- ⚡ **Read & offset caches** — lock-free fast path, cross-worker invalidation via version cells
- 🧹 **Defragmentation** — automatic reclamation of dead space
- 🪄 **Proxy-based API** — `Shared()` with direct getter/setter access
- 🧵 **Automatic worker integration** — no manual buffer serialization

## 📦 Install

```sh
bun add bun-shared-memory
```

See [SPEC.md](./SPEC.md) for the full specification.

## 📊 Stats

|                       |                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**           | [![npm version](https://img.shields.io/npm/v/bun-shared-memory?color=cb3837)](https://www.npmjs.com/package/bun-shared-memory)                                      |
| **Downloads / month** | [![npm downloads](https://img.shields.io/npm/dm/bun-shared-memory?color=cb3837)](https://www.npmjs.com/package/bun-shared-memory)                                   |
| **Stars**             | [![GitHub stars](https://img.shields.io/github/stars/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory)                   |
| **Forks**             | [![GitHub forks](https://img.shields.io/github/forks/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory)                   |
| **Open issues**       | [![GitHub issues](https://img.shields.io/github/issues/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory/issues)          |
| **Open PRs**          | [![GitHub pull requests](https://img.shields.io/github/issues-pr/Kapsonfire/bun-shared-memory?color=181717)](https://github.com/Kapsonfire/bun-shared-memory/pulls) |
| **License**           | [![License](https://img.shields.io/github/license/Kapsonfire/bun-shared-memory?color=green)](https://github.com/Kapsonfire/bun-shared-memory/blob/main/LICENSE)     |
| **Language**          | [![TypeScript](https://img.shields.io/badge/TypeScript-7-blue?color=3178c6)](https://www.typescriptlang.org)                                                        |

## Data Types

- **Allowed**: primitives (`number`, `string`, `boolean`), `bigint`, and arrays of these (mixed arrays allowed).
- **BigInts** of any size are supported: values that fit in 64 bits are stored as a fast int64 slot; larger values are stored as their decimal string in the StringTable.
- **Objects** have a **fixed shape**: once created, properties may not be added or removed — only their values can change.
- **Nested objects and arrays** are supported: an object or array can contain other plain objects and arrays (read lazily, mutated in place).
- **Nested `Shared` references**: a `Shared` object can be stored inside another object or array as a _live reference_ — both stay in sync (mutating either updates the same shared value). Self-references and mutual references are supported as long as the property exists in the object's initial fixed shape.
- **`null` is allowed** as a value (top-level, object property, or array element).
- **Not allowed** (a `TypeError` is thrown, nothing is stored): `undefined`, functions, symbols, sparse arrays, and objects that are not plain data — `Date`, `Map`, `Set`, `RegExp`, typed arrays, `Error`, ... Convert them first (`date.getTime()`, `Object.fromEntries(map)`, `[...set]`).

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

// Nested objects are read lazily and mutated in place
const doc = Shared("doc-1", {
  profile: { name: "Alice", meta: { level: 3 } },
});
doc.profile.meta.level++;
doc.profile.meta.level; // 4

// Nested Shared values are live references that stay in sync
const settings = Shared("settings-1", { theme: "dark" });
const app = Shared("app-1", { settings });
app.settings.theme = "light";
settings.theme; // "light" (same shared value)

// Primitives use read()/write()/update()
const counter = Shared<number>("counter-1", 0);
counter.write(42);
counter.update((n) => n + 1);

// Or create it with a loader function (sync or async)
const user2 = await Shared<User>("user-2", async () => {
  return await fetchUser();
});
// The loader runs only if the key does not exist yet (once per thread, even for
// concurrent calls); if it throws, nothing is registered and you can retry.
```

In a worker, `await init()` requests the shared buffers from the main thread
and reconstructs the same memory, so `Shared()` reads/writes the same data as
the main thread. See [Worker integration](#worker-integration) below.

## Synchronization

Concurrent access from multiple workers is safe: writes are serialized **per
key** with `Atomics`-based locks, and reads of unchanged values are lock-free
(see below).

### Write locking (per-key lock stripes)

Every write holds the lock of its key: one of 256 re-entrant mutexes (a "stripe",
chosen by the key's position in the Index Table), so

- writers to **different keys run in parallel**,
- writers to the **same key** wait for each other, which keeps read-modify-write
  sequences (`update()`, `push`, property assignment) atomic,
- key creation and defragmentation are the only operations that take the global
  mutex (defragmentation takes every stripe, so it excludes all writers).

Reads never see half a write: a write marks the key's version cell while it runs
and lock-free property reads validate it (a seqlock), so a string is never
assembled from two writes. An ordinary write also waits for another thread's
`withReadLock`/`withWriteLock` on the same key.

> **Scalability.** With 8 workers each writing its own key the total throughput
> is ~8× that of one worker (`bun run bench:contention`; with the former single
> global write mutex it _dropped_ as writers were added). 8 workers hammering the
> _same_ key stay at roughly single-writer speed. Reads of one hot key by many
> workers scale linearly too (`bun run bench:readscale`). A single write costs ~20–40×
> native. Reads of unchanged values are lock-free and fast (~3–7× native for
> primitives and object properties, ~8–11× for array elements). After a
> value changed, reading an **object property** is still lock-free (only that
> property's slot is decoded), while reading a **whole value** (`read()`, a
> top-level primitive, or an array element) takes that key's stripe once to
> refill its cache.
>
> Keys created one after another sit next to each other in memory, so
> simultaneously hot neighbours share cache lines (false sharing) and scale less
> well than keys that are far apart.
>
> Code that holds a key's lock (an `update()` callback, `withWriteLock`) and
> writes a _different_ key takes that key's lock too: two threads doing this in
> opposite order can deadlock and fail with a `LockTimeoutError`. Keep such
> callbacks to a single key or use a consistent key order.

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

#### Crashed lock holders: timeouts and recovery

Every lock wait (`Mutex`, `RWLock`, the per-object `withReadLock` /
`withWriteLock` seqlock) is bounded. If a worker dies while holding a lock,
waiters throw a `LockTimeoutError` after 30 s instead of hanging forever.

```ts
import {
  Mutex,
  setDefaultLockTimeout,
  LockTimeoutError,
} from "bun-shared-memory";

setDefaultLockTimeout(5_000); // per thread; Infinity = wait forever
const mutex = new Mutex(buffer, { timeoutMs: 1_000 }); // per lock

try {
  mutex.lock();
} catch (e) {
  if (e instanceof LockTimeoutError) {
    // The holder is probably dead. Its thread id is recorded in the lock:
    mutex.forceUnlock(mutex.owner); // only if you know the owner is gone!
  }
}
```

A forced unlock may leave the protected data half-written, so only use it when
the owner is known to be dead. The mutex stores the owning thread id _inside_
the state cell (so an uncontended lock/unlock pair needs just two atomic
operations) plus the re-entrancy depth in the next cell, which lets several
`Mutex` instances over the same buffer in one thread see each other's holds.

### Notifier

A cross-worker notification primitive built on `Atomics.wait`/`Atomics.notify`.

```ts
import { Notifier } from "bun-shared-memory";

const notifier = new Notifier();
// pass notifier.buffer to other workers, then:
notifier.wait(); // block until notified
notifier.notify(1); // wake one waiting worker
```

## Memory reclamation

The shared buffers are append-only, so dead space (overwritten strings,
abandoned array blocks, replaced objects) is not reused on its own. A
**defragmentation** pass compacts all tables when they fill up.

With the worker integration (`init()`) this is automatic: `init()` starts a
`MaintenanceCoordinator` on the main thread. It checks every 100 ms whether a
table is nearly full (80 % by default), defragments if so, and broadcasts the
new chunk lists to the workers. It also force-releases the locks of a worker
that closes while holding them.

```ts
import { Shared, init } from "bun-shared-memory";

await init(); // main thread: starts the coordinator
const user = Shared("user-1", { name: "Alice" });
```

You can also wire it up manually (e.g. when not using `init()`):

```ts
import { SharedMemory, MaintenanceCoordinator } from "bun-shared-memory";

const mem = new SharedMemory();
const coord = new MaintenanceCoordinator(mem, {
  defragThreshold: 0.8, // fraction of a table's capacity
  onDefragment: (chunks) => {
    /* send `chunks` to your workers, they call mem.applyChunkUpdate(chunks) */
  },
});
coord.autoRegister(); // release locks of workers that close (Bun)
// coord.runDefrag() compacts immediately; coord.stopAutoMaintenance() stops the timer.
```

A write that runs out of budget also reclaims dead space immediately
(`memory.reclaimHook`), without waiting for the timer. See
[DESIGN.md](./DESIGN.md) for the details.

## Memory use per thread

The values live in the shared buffers (about 40 bytes of index entry, key name
and slot for a number key). In addition each thread keeps a small JS object per
key it uses — the reference `Shared()` returns — of roughly 0.9 KB for a
primitive or array and 2 KB for an object with four properties, plus a few
entries in per-thread caches. References are held weakly: once your code drops a
reference, the garbage collector frees it and its cache entries (about 160 bytes
per key remain, the thread's key → index map). While you hold a reference,
`Shared(key)` returns the same object. `bun bench/heap.ts` and
`bun bench/gcheap.ts` measure this.

Methods such as `ref.write` use `this`, so call them on the reference
(`ref.write(x)`); a detached `const { write } = ref` does not work.

## One SharedMemory per thread

A thread (the main thread or each worker) holds **exactly one** `SharedMemory`.
Creating a second one throws, because the per-thread caches are keyed by key
name only. The memory is **created on the main thread only**: workers never
create a fresh memory, they receive the main thread's buffers via
`await init()` (or `SharedMemory.fromBuffers()`), so every thread addresses the
same data.

```ts
const mem = new SharedMemory(); // main thread: OK
new SharedMemory(); // Error: a SharedMemory already exists in this thread
SharedMemory.current(); // the single live instance (or null)
mem.dispose(); // frees the slot and resets the caches (tests, teardown)
```

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
buffer-request listener and starts the maintenance coordinator (auto-defrag and
worker auto-registration), and in a worker it performs the request/response
handshake and reconstructs the shared buffers. `Shared()` never overwrites a value
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

### Browser & Web Workers

The core (`SharedArrayBuffer`/`Atomics`) runs identically in modern browsers,
so `Shared`/`SharedMemory`/`Mutex`/`Notifier` work there out of the box. Only
the worker handshake differs: Bun auto-discovers workers via
`process.on("worker", ...)`, but browsers have no equivalent — each Web Worker
must be registered explicitly.

Two differences to keep in mind:

1. **No auto-registration.** In the browser, call `init()` on the main thread
   and then register each worker you create with `acceptWorker(worker)` (or
   use `spawnWorker()`, which does it for you).
2. **`SharedArrayBuffer` needs cross-origin isolation.** Serve your app with
   `COOP: same-origin` and `COEP: require-corp` response headers, otherwise
   `SharedArrayBuffer` is unavailable in the browser.

```ts
// main.ts
import { Shared, init, spawnWorker } from "bun-shared-memory";

await init({ initialSize: 64 * 1024, maxByteLength: 4 * 1024 * 1024 * 1024 });
const user = Shared("user-1", { name: "Alice", age: 30 });

// spawnWorker() creates the worker and registers it with the handshake.
const worker = spawnWorker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
worker.postMessage("read");
```

```ts
// worker.ts — identical to the Bun version
import { Shared, init, onMessage } from "bun-shared-memory";

await init(); // request the shared buffers from the main thread
onMessage(async (e) => {
  const user = Shared("user-1", { name: "x" });
  self.postMessage(user.read());
});
```

`spawnWorker()` is a thin cross-platform wrapper over `new Worker()` that
automatically calls `acceptWorker()` on the browser main thread (and is a no-op
overhead in Bun, where workers are auto-registered). If you prefer to build the
`Worker` yourself, call `acceptWorker(worker)` after constructing it.

> **Note on worker lifecycle.** In Bun, the coordinator learns about new
> workers via `process.on("worker", ...)` and detects a dead worker via its
> `close` event. Browsers expose neither, so `acceptWorker(worker)` /
> `spawnWorker()` register each Web Worker explicitly. Neither Bun
> (`worker.terminate()`) nor browsers report a terminated worker reliably, so
> call `coordinator.unregisterWorker(worker)` to release its locks right away;
> otherwise other threads wait for their lock timeout (30 s by default,
> `LockTimeoutError`). Automatic defragmentation works the same everywhere.

> **Blocking on the browser main thread.** `Atomics.wait` is forbidden on the
> browser main thread. Locks, `Notifier` and the object seqlock fall back to a
> bounded busy-wait there, which works but blocks the UI while a lock is
> contended. Do heavy or write-intensive work in Web Workers and keep main-thread
> access to short, mostly read-only operations.

## Memory budget

The Index Table (including each key's version counter) uses one growable
`SharedArrayBuffer`, capped at **4 GiB** by default (configurable via
`indexTableMaxByteLength`). The DataTable, StringTable, and ArrayTable use
chunks and can individually exceed 4 GiB. By default each table grows up to
its own `maxByteLength`, so the _total_ memory can be several times that.

Configure the buffers when calling `init()` — pass `initialSize` (each
table's starting size, avoiding a grow on first use) and `maxByteLength`
(each table's cap). To cap the combined physical memory of DataTable,
StringTable, and ArrayTable, pass `maxTotalBytes`. The Index Table is excluded
from this budget. Its growth and chunk growth in workers reserve memory from
the same atomic budget before allocating, so the three tables cannot exceed it.

```ts
import { init } from "bun-shared-memory";

// The Index Table grows up to 4 GiB independently. DataTable, StringTable, and
// ArrayTable together are capped at 4 GiB.
await init({
  initialSize: 64 * 1024,
  maxByteLength: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
});
```

`maxTotalBytes` caps the **sum** of the physical sizes of DataTable,
StringTable, and ArrayTable, including across workers. If a write would exceed
the budget, a `RangeError` is thrown before the chunk grows. Without
`maxTotalBytes`, each table simply grows up to its own `maxByteLength`.

### Size limits

The following limits are enforced regardless of the configured values:

- **`chunkSize` is at least 4 MiB.** A smaller value is raised to 4 MiB.
- **`maxTotalBytes` / `maxByteLength` are at least 32 MiB.** A smaller value
  is raised to 32 MiB.
- **No table uses more than 1024 chunks.** `chunkSize` is raised as needed so
  that `ceil(maxByteLength / chunkSize) ≤ 1024` (e.g. an 8 GiB table with a
  4 MiB chunk would need 2048 chunks, so the chunk size is raised to 8 MiB).

These keep the chunk count bounded (so the pre-allocated chunk list stays
small) and avoid pathological tiny chunks.

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
bun run test:coverage  # tests + coverage report (coverage/lcov.info, used by Sonar)
bun fmt            # format code
bun run bench      # run benchmarks
```

## Benchmarks

`bun run bench` compares shared-memory access against native JS access for
every supported data type and its arrays:

- **Primitives**: `number`, `string`, `boolean`, `bigint` (read + write)
- **Arrays**: `number[]`, `string[]`, `boolean[]`, `bigint[]`, `mixed[]` (index read, index write)
- **Objects**: property read/write and array-property access

Each case runs in its own process (so the JIT feedback of one case cannot
change the next one; a run takes about 1.5 minutes) and reports ops/sec for the
native and shared paths, plus the relative slowdown. `bun run bench` writes a log
to `benchlogs/`; see [BENCH.md](./BENCH.md) for the history.

With the read cache and offset cache, **reads** are typically 3–11× slower than
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

### Real-world benchmark

See [📈 Real-world benchmark](#-real-world-benchmark) at the top of this
README for the measured results.

## 🤝 Contributing

Contributions are welcome! Please open an issue or pull request.

- 🐛 [Report a bug](https://github.com/Kapsonfire/bun-shared-memory/issues/new?labels=bug)
- 💡 [Request a feature](https://github.com/Kapsonfire/bun-shared-memory/issues/new?labels=enhancement)
- 📖 [Browse open issues](https://github.com/Kapsonfire/bun-shared-memory/issues)
- 🔀 [Open a pull request](https://github.com/Kapsonfire/bun-shared-memory/pulls)

## 📄 License

[MIT](./LICENSE) © [Kapsonfire](https://github.com/Kapsonfire)
