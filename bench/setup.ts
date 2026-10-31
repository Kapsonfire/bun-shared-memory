import {
  RefCountBuffer,
  RefCountTracker,
  SharedMemory,
  type SharedOptions,
} from "../src/index.ts";

/**
 * Shared benchmark setup: a single SharedMemory with a large buffer and a
 * RefCountTracker so `read()` of arrays/objects exercises the same refcount
 * path as real usage.
 *
 * No RefCountCoordinator/defragmentation is needed: the push benchmarks (which
 * grew arrays and left dead slots) have been removed, so the buffers never
 * overflow during a measurement.
 */
const mem = new SharedMemory({ maxByteLength: 512 * 1024 * 1024 }); // 512 MiB

const refBuffer = new RefCountBuffer();
const workerId = refBuffer.allocateWorkerId();
const tracker = new RefCountTracker(refBuffer, workerId);

/** Shared options for benchmarks: large buffer + refcount tracking. */
export const benchOptions: SharedOptions = {
  memory: mem,
  refCount: tracker,
};
