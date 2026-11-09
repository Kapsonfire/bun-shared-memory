import { SharedMemory, type SharedOptions } from "../src/index.ts";

/**
 * Shared benchmark setup: a single SharedMemory with a large buffer.
 *
 * No MaintenanceCoordinator/defragmentation is needed: the push benchmarks (which
 * grew arrays and left dead slots) have been removed, so the buffers never
 * overflow during a measurement.
 */
// Pre-size each buffer so no `grow()` (new SharedArrayBuffer + DataView
// rebuild) happens during a measurement. The benchmarks only use a few KB per
// buffer, so 64 KiB is more than enough headroom.
const mem = new SharedMemory({
  initialSize: 64 * 1024, // 64 KiB per buffer
  maxByteLength: 4 * 1024 * 1024 * 1024, // 4 GiB
});

/** Shared options for benchmarks: a large pre-sized buffer. */
export const benchOptions: SharedOptions = {
  memory: mem,
};
