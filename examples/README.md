# Examples

## Worker integration (`worker/`)

Demonstrates sharing data between the main thread and a worker using the
automatic buffer handshake. The main thread creates a shared value and calls
`init()`; the worker calls `await init()` to receive the shared buffers, then
uses `Shared()` to read and write the same value. The worker increments the
shared counter 5 times, reporting the value after each write and each read.

```bash
bun run examples/worker/main.ts
```

Expected output (abridged):

```
Worker: read -> 0
Worker: write -> 1
Main thread: worker write -> value 1
Main thread: counter.read() -> 1
Main thread: worker read -> value 1
Main thread: counter.read() -> 1
...
Worker: read -> 4
Worker: write -> 5
Main thread: worker write -> value 5
Main thread: counter.read() -> 5
Main thread: worker read -> value 5
Main thread: counter.read() -> 5
```
