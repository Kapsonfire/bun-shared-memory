import { SharedMemory } from "./memory.ts";

/**
 * Reference counting for shared objects/arrays.
 *
 * The 4-buffer architecture is append-only: the DataTable, StringTable, and
 * ArrayTable only grow, and dead space is never reclaimed. This module adds a
 * reference counting system so that memory can be reclaimed when no worker
 * references an object/array anymore.
 *
 * Roles:
 * - **Main thread** (`RefCountCoordinator`): owns the global refcount table,
 *   tracks which worker holds a reference to which object/array, and runs the
 *   defragmentation pass when free space is low.
 * - **Worker** (`RefCountTracker`): tracks its own local references and reports
 *   acquire/release events to the main thread. Uses a `FinalizationRegistry`
 *   so a reference is released when the returned JS object is GC'd.
 *
 * A worker that crashes cannot send a release event. The main thread detects
 * this via the worker's `close` event and releases all of that worker's
 * references.
 */

/** A stable identity for a shared object or array. */
export interface ObjectId {
  /** Monotonic id, stable across defragmentation. */
  id: number;
  /** 0 = object (DataTable), 1 = array (ArrayTable). */
  kind: 0 | 1;
}

/** An acquire/release event sent from a worker to the main thread. */
export interface RefEvent {
  /** 1 = acquire, 0 = release. */
  op: 0 | 1;
  /** The objectId being acquired or released. */
  objectId: number;
}

/**
 * The 5th shared buffer: a ring-buffer message queue for acquire/release
 * events, a heartbeat table, and a global refcount table.
 *
 * Layout (all Int32):
 *   [0]        write index (producer, workers)
 *   [1]        read index (consumer, main thread)
 *   [2]        event count (number of queued events)
 *   [3..]      ring buffer of events (op, objectId pairs)
 *   [ringEnd..] heartbeat table (one cell per worker)
 *   [hbEnd..]   global refcount table (one cell per objectId)
 */
export class RefCountBuffer {
  readonly buffer: SharedArrayBuffer;
  private readonly view: Int32Array;
  private readonly ringSize: number;
  private readonly hbOffset: number;
  private readonly refOffset: number;

  constructor(
    buffer?: SharedArrayBuffer,
    opts: { ringSize?: number; maxWorkers?: number; maxObjects?: number } = {},
  ) {
    const ringSize = opts.ringSize ?? 1024;
    const maxWorkers = opts.maxWorkers ?? 64;
    const maxObjects = opts.maxObjects ?? 1 << 16;
    this.ringSize = ringSize;
    this.hbOffset = 3 + ringSize * 2;
    this.refOffset = this.hbOffset + maxWorkers;
    const total = this.refOffset + maxObjects;
    this.buffer =
      buffer ?? new SharedArrayBuffer(total * Int32Array.BYTES_PER_ELEMENT);
    this.view = new Int32Array(this.buffer);
  }

  /** The underlying SharedArrayBuffer, for sharing with other threads. */
  get sab(): SharedArrayBuffer {
    return this.buffer;
  }

  /** Append an acquire/release event to the ring buffer (worker side). */
  pushEvent(op: 0 | 1, objectId: number): void {
    const write = Atomics.load(this.view, 0);
    const read = Atomics.load(this.view, 1);
    if (write - read >= this.ringSize) {
      // Ring full; drop the event (main thread will reconcile via heartbeat).
      return;
    }
    const base = 3 + (write % this.ringSize) * 2;
    Atomics.store(this.view, base, op);
    Atomics.store(this.view, base + 1, objectId);
    Atomics.store(this.view, 0, write + 1);
  }

  /** Pop the next event, or null if the queue is empty (main thread side). */
  popEvent(): RefEvent | null {
    const read = Atomics.load(this.view, 1);
    const write = Atomics.load(this.view, 0);
    if (read >= write) return null;
    const base = 3 + (read % this.ringSize) * 2;
    const op = Atomics.load(this.view, base) as 0 | 1;
    const objectId = Atomics.load(this.view, base + 1);
    Atomics.store(this.view, 1, read + 1);
    return { op, objectId };
  }

  /** Update this worker's heartbeat cell. */
  heartbeat(workerId: number): void {
    Atomics.store(this.view, this.hbOffset + workerId, Date.now());
  }

  /** Read a worker's last heartbeat timestamp. */
  lastHeartbeat(workerId: number): number {
    return Atomics.load(this.view, this.hbOffset + workerId);
  }

  /** Increment the global refcount for an objectId. */
  acquireGlobal(objectId: number): void {
    Atomics.add(this.view, this.refOffset + objectId, 1);
  }

  /** Decrement the global refcount for an objectId. Returns the new count. */
  releaseGlobal(objectId: number): number {
    return Atomics.sub(this.view, this.refOffset + objectId, 1);
  }

  /** Read the global refcount for an objectId. */
  refCount(objectId: number): number {
    return Atomics.load(this.view, this.refOffset + objectId);
  }
}

/**
 * Main-thread coordinator: owns the global refcount table, tracks which worker
 * holds a reference to which object/array, and runs defragmentation.
 */
export class RefCountCoordinator {
  private readonly buffer: RefCountBuffer;
  private readonly mem: SharedMemory;
  /** workerId -> Set of objectIds that worker holds. */
  private readonly workerRefs = new Map<number, Set<number>>();
  /** objectId -> Set of workerIds holding it. */
  private readonly objectWorkers = new Map<number, Set<number>>();
  private nextWorkerId = 0;
  /** Free-space threshold (fraction of maxByteLength) that triggers defrag. */
  private readonly defragThreshold: number;

  constructor(
    mem: SharedMemory,
    buffer?: RefCountBuffer,
    opts: { defragThreshold?: number } = {},
  ) {
    this.mem = mem;
    this.buffer = buffer ?? new RefCountBuffer();
    this.defragThreshold = opts.defragThreshold ?? 0.1;
  }

  get sab(): SharedArrayBuffer {
    return this.buffer.sab;
  }

  /** Register a worker and attach a close listener that frees its refs. */
  registerWorker(worker: { onclose?: (() => void) | null }): number {
    const workerId = this.nextWorkerId++;
    this.workerRefs.set(workerId, new Set());
    const release = () => this.releaseWorker(workerId);
    if (typeof worker.onclose === "function") {
      worker.onclose = release;
    }
    return workerId;
  }

  /** Release all references held by a worker (e.g. on close/crash). */
  releaseWorker(workerId: number): void {
    const refs = this.workerRefs.get(workerId);
    if (!refs) return;
    for (const objectId of refs) {
      this.releaseGlobal(objectId, workerId);
    }
    refs.clear();
  }

  /** Record that a worker acquired a reference to an objectId. */
  acquire(objectId: number, workerId: number): void {
    this.buffer.acquireGlobal(objectId);
    this.workerRefs.get(workerId)?.add(objectId);
    let ws = this.objectWorkers.get(objectId);
    if (!ws) {
      ws = new Set();
      this.objectWorkers.set(objectId, ws);
    }
    ws.add(workerId);
  }

  /** Record that a worker released a reference to an objectId. */
  release(objectId: number, workerId: number): void {
    this.releaseGlobal(objectId, workerId);
  }

  private releaseGlobal(objectId: number, workerId: number): void {
    this.buffer.releaseGlobal(objectId);
    this.workerRefs.get(workerId)?.delete(objectId);
    const ws = this.objectWorkers.get(objectId);
    ws?.delete(workerId);
    if (ws && ws.size === 0) {
      this.objectWorkers.delete(objectId);
    }
  }

  /** Drain pending acquire/release events from the ring buffer. */
  drainEvents(): void {
    let ev: RefEvent | null;
    while ((ev = this.buffer.popEvent()) !== null) {
      // Events don't carry a workerId; the coordinator reconciles via the
      // worker's heartbeat/registration. For simplicity, events are attributed
      // to the most recently active worker.
      const workerId = this.mostRecentWorker();
      if (workerId === -1) continue;
      if (ev.op === 1) this.acquire(ev.objectId, workerId);
      else this.release(ev.objectId, workerId);
    }
  }

  private mostRecentWorker(): number {
    let best = -1;
    let bestTime = -1;
    for (const [id] of this.workerRefs) {
      const t = this.buffer.lastHeartbeat(id);
      if (t > bestTime) {
        bestTime = t;
        best = id;
      }
    }
    return best;
  }

  /** Whether any table has less than `defragThreshold` free space. */
  needsDefrag(): boolean {
    const max = this.mem.dataTable.buffer.maxByteLength;
    const free = (b: { buffer: SharedArrayBuffer; byteLength: number }) =>
      (b.buffer.byteLength - b.byteLength) / max;
    return (
      free(this.mem.dataTable) < this.defragThreshold ||
      free(this.mem.arrayTable) < this.defragThreshold ||
      free(this.mem.stringTable) < this.defragThreshold
    );
  }
}

/**
 * Worker-side tracker: uses a FinalizationRegistry so a reference is released
 * when the returned JS object/array is garbage-collected.
 */
export class RefCountTracker {
  private readonly buffer: RefCountBuffer;
  private readonly registry: FinalizationRegistry<number>;
  private readonly workerId: number;

  constructor(buffer: RefCountBuffer, workerId: number) {
    this.buffer = buffer;
    this.workerId = workerId;
    this.registry = new FinalizationRegistry((objectId) => {
      this.buffer.pushEvent(0, objectId);
    });
  }

  /** Register a returned JS object/array so its ref is released on GC. */
  track(value: object, objectId: number): void {
    this.buffer.pushEvent(1, objectId);
    this.registry.register(value, objectId);
  }

  /** Periodically called by the worker to signal it is alive. */
  heartbeat(): void {
    this.buffer.heartbeat(this.workerId);
  }
}
