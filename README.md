# shared-memory

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

See [SPEC.md](./SPEC.md) for the full specification.

## Status

🚧 **M1 — Foundation** (in progress): Project scaffolding and basic `SharedArrayBuffer` wrapper.

## Usage

```ts
import { SharedMemory } from "shared-memory";

// Create a shared memory region
const shared = new SharedMemory(1024);

// Typed access
const view = shared.view(Uint8Array);
view[0] = 42;

// Pass the raw buffer to a worker
const buffer = shared.raw;
```

## Development

```bash
bun install        # install dependencies
bun run typecheck  # type check (bun check)
bun test           # run tests
bun fmt            # format code
```
