# SPEC.md

## Project Goal

A TypeScript library for the **Bun** runtime that enables sharing data between workers/threads using `SharedArrayBuffer`.

## Overview

Bun supports worker threads, but passing data between them typically requires structured cloning (copying) or message passing. This library aims to provide a zero-copy, high-performance mechanism for sharing data between workers using `SharedArrayBuffer`, allowing multiple threads to read and write the same underlying memory without serialization overhead.

## Core Concepts

- **SharedArrayBuffer**: A fixed-length binary data buffer that can be shared between threads, providing true shared memory.
- **Workers**: Bun's `Worker` API for running code in separate threads.
- **Zero-copy**: Data is written once to shared memory and read directly by consumers, avoiding serialization/deserialization costs.

## Goals

- Provide a simple, ergonomic API for creating and sharing typed data between workers.
- Support common data types (numbers, strings, structured objects) over shared memory.
- Handle synchronization between workers (e.g., `Atomics` for coordination).
- Zero-copy reads/writes where possible.
- Type-safe with full TypeScript typings.

## Non-Goals (Initial Scope)

- No distributed/shared memory across processes (only threads within a single process).
- No persistence or disk-backed storage.
- No automatic garbage collection of shared memory (manual lifecycle management).

## Proposed API (Draft)

> This is a preliminary sketch and subject to change.

```ts
// Get a wrapper to user-1 in shared memory. If it doesn't exist, create it with the provided initial value.
const user = Shared<User>('user-1', { name: 'Alice', age: 30 });

const user2 = Shared<User>('user-1', loader); // Get a wrapper to user-1 in shared memory. If it doesn't exist, create it with the provided loader function. The loader function may be async


```

## Milestones

1. **M1 — Foundation**: Project scaffolding, build tooling, basic `SharedArrayBuffer` wrapper.
2. **M2 — Typed data**: Support for typed arrays and primitive serialization.
3. **M3 — Synchronization**: `Atomics`-based locking and notifications between workers.
4. **M4 — Worker integration**: Seamless usage within Bun `Worker` threads.
5. **M5 — Polish**: Documentation, benchmarks, and examples.

## Open Questions

- What is the exact serialization format for structured data?
- How should memory be allocated and sized (fixed vs. growable)?
- What synchronization primitives should be exposed to users?
