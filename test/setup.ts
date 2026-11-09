import { afterEach } from "bun:test";
import { SharedMemory } from "../src/index.ts";

// A thread may hold only one SharedMemory. Release it after every test so each
// test starts with a clean slot (and clean per-thread caches).
afterEach(() => {
  SharedMemory.current()?.dispose();
});
