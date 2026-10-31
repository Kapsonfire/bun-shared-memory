import {
  RefCountBuffer,
  RefCountCoordinator,
  RefCountTracker,
  SharedMemory,
  type SharedOptions,
} from "../src/index.ts";

/**
 * Shared benchmark setup: a single SharedMemory with a large buffer and a
 * RefCountCoordinator that runs defragmentation when free space runs low.
 *
 * The benchmarks exercise growing operations (push) that would otherwise
 * exhaust the append-only buffers. The coordinator's periodic maintenance
 * reclaims dead space so the buffers don't overflow during a 5s measurement.
 */
const mem = new SharedMemory({ maxByteLength: 512 * 1024 * 1024 }); // 512 MiB

const refBuffer = new RefCountBuffer();
const coordinator = new RefCountCoordinator(mem, refBuffer, {
  autoMaintenance: true,
  maintenanceInterval: 50,
});
const workerId = refBuffer.allocateWorkerId();
const tracker = new RefCountTracker(refBuffer, workerId);

/** Shared options for benchmarks: large buffer + refcount/defrag tracking. */
export const benchOptions: SharedOptions = {
  memory: mem,
  refCount: tracker,
};

/** Keep the coordinator alive for the lifetime of the benchmark process. */
export function keepAlive(): void {
  // The coordinator's maintenance timer keeps running; this reference prevents
  // it from being GC'd.
  void coordinator;
}
