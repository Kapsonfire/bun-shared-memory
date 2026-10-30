# shared-memory

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

See [SPEC.md](./SPEC.md) for the full specification.

## Status

🚧 **M2 — Typed data**: `Shared<T>` API with serialization of primitives, bigints, and arrays.

## Data Types

- **Allowed**: primitives (`number`, `string`, `boolean`), `bigint`, and arrays of these (mixed arrays allowed).
- **Objects** have a **fixed shape**: once created, properties may not be added or removed — only their values can change.
- **Not allowed**: nested objects, nested arrays, `null`, `undefined`.

## Usage

```ts
import { Shared } from "shared-memory";

// Get a wrapper to a named value in shared memory.
// If it doesn't exist, create it with the provided initial value.
const user = Shared<User>("user-1", { name: "Alice", age: 30 });

// Read the current value
const value = user.read();

// Write a new value (must keep the same object shape)
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
