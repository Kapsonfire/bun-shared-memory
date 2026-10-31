# Examples

## Worker integration (`worker/`)

Demonstrates sharing data between the main thread and a worker using the
automatic buffer handshake. The main thread creates a shared value and calls
`init()`; the worker calls `await init()` to receive the shared buffers, then
uses `Shared()` to read and write the same value.

```bash
bun run examples/worker/main.ts
```

Expected output:

```
Main thread received: incremented to 1
Shared counter value: { value: 1 }
```
