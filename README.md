# shared-memory

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

See [SPEC.md](./SPEC.md) for the full specification.

## Status

🚧 **M3 — Synchronization**: `Atomics`-based locking (`Mutex`) and notifications (`Notifier`) between workers, integrated into all shared-memory operations.

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
```
