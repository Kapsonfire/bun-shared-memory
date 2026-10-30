# shared-memory

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

See [SPEC.md](./SPEC.md) for the full specification.

## Status

🚧 **M2 — Typed data**: `Shared<T>` API with serialization of primitives and structured objects.

## Usage

```ts
import { Shared } from "shared-memory";

// Get a wrapper to a named value in shared memory.
// If it doesn't exist, create it with the provided initial value.
const user = Shared<User>("user-1", { name: "Alice", age: 30 });

// Read the current value
const value = user.read();

// Write a new value
user.write({ name: "Alice", age: 31 });

// Atomically update using a transform
user.update((u) => ({ ...u, age: u.age + 1 }));

// Or create it with a loader function (sync or async)
const user2 = await Shared<User>("user-2", async () => {
  return await fetchUser();
});
```

## Development

```bash
bun install        # install dependencies
bun run typecheck  # type check (bun check)
bun test           # run tests
bun fmt            # format code
```
