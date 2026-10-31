import { benchPair } from "./helpers.ts";
import { Shared } from "../src/index.ts";

/**
 * Benchmark the read-cache version check against a native object.
 *
 * The read cache keeps a per-key version cell in a shared Int32Array and a
 * per-worker Map cache. On each read we do:
 *
 *   1. Atomics.load(versionCell)   — lock-free, non-blocking
 *   2. Map.get(key)                — cache lookup
 *   3. property access on the cached object
 *
 * This compares the cached shared read against a plain native object read.
 */

// Native baseline.
const native = { name: "Alice", age: 30, active: true };

// Shared value (read through the cache).
const sharedUser = Shared("cache-bench-user", {
  name: "Alice",
  age: 30,
  active: true,
});

function nativeRead(): unknown {
  return native.name;
}

function sharedRead(): unknown {
  return sharedUser.name;
}

benchPair("native vs cached shared read", nativeRead, sharedRead);
