# todo-list

A simple in-memory todo list with a native HTML/CSS/JS frontend and an
[Elysia](https://elysiajs.com) backend running on Bun.

## Architecture

The app demonstrates `bun-shared-memory` across multiple workers:

- **Main thread** (`index.ts`) seeds the shared todo store and spawns **4
  Elysia listener workers**.
- **Workers** (`worker.ts`) call `await init()` to receive the shared
  `SharedArrayBuffer`s from the main thread, then each runs an Elysia API that
  reads/writes the **same** todo store through `Shared()` (Atomics-synchronized).
- All 4 workers listen on the **same port** (`3001`) using `reusePort`, so the
  OS load-balances incoming requests across them.
- **Frontend** (`public/`) is served on port `3000` and talks to the shared
  API port.

Because all workers share the same buffers, a todo added via one worker is
immediately visible through all others.

## Run

The example imports `bun-shared-memory` from the local source
(`../../src/index.ts`) so it always uses the current code in this repo.

```bash
bun install
bun run index.ts
```

Then open http://localhost:3000

## API

All 4 workers share one port (`3001`) via `reusePort`:

| Method | Path             | Description         |
| ------ | ---------------- | ------------------- |
| GET    | `/api/todos`     | List all todos      |
| POST   | `/api/todos`     | Create a todo       |
| PATCH  | `/api/todos/:id` | Update title / done |
| DELETE | `/api/todos/:id` | Delete a todo       |

## Type check

```bash
bun check
```
