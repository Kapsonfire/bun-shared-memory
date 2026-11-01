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
  /** The worker that sent the event. */
  workerId: number;
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
 *   [2]        next worker id (allocated by workers)
 *   [3..]      ring buffer of events (workerId, op, objectId triples)
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
    this.hbOffset = 3 + ringSize * 3;
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

  /**
   * Allocate a unique worker id (worker side). Each worker calls this once to
   * obtain its id, which it uses for heartbeats and events.
   */
  allocateWorkerId(): number {
    return Atomics.add(this.view, 2, 1);
  }

  /** Append an acquire/release event to the ring buffer (worker side). */
  pushEvent(workerId: number, op: 0 | 1, objectId: number): void {
    const write = Atomics.load(this.view, 0);
    const read = Atomics.load(this.view, 1);
    if (write - read >= this.ringSize) {
      // Ring full; drop the event (main thread will reconcile via heartbeat).
      return;
    }
    const base = 3 + (write % this.ringSize) * 3;
    Atomics.store(this.view, base, workerId);
    Atomics.store(this.view, base + 1, op);
    Atomics.store(this.view, base + 2, objectId);
    Atomics.store(this.view, 0, write + 1);
  }

  /** Pop the next event, or null if the queue is empty (main thread side). */
  popEvent(): RefEvent | null {
    const read = Atomics.load(this.view, 1);
    const write = Atomics.load(this.view, 0);
    if (read >= write) return null;
    const base = 3 + (read % this.ringSize) * 3;
    const workerId = Atomics.load(this.view, base);
    const op = Atomics.load(this.view, base + 1) as 0 | 1;
    const objectId = Atomics.load(this.view, base + 2);
    Atomics.store(this.view, 1, read + 1);
    return { workerId, op, objectId };
  }

  /**
   * Update this worker's heartbeat cell. Uses a monotonic counter that fits in
   * an Int32 (Date.now() overflows Int32), so the main thread can detect a
   * worker that stopped heartbeating.
   */
  heartbeat(workerId: number): void {
    const prev = Atomics.load(this.view, this.hbOffset + workerId);
    Atomics.store(this.view, this.hbOffset + workerId, (prev + 1) | 0);
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
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    mem: SharedMemory,
    buffer?: RefCountBuffer,
    opts: {
      defragThreshold?: number;
      autoMaintenance?: boolean;
      maintenanceInterval?: number;
    } = {},
  ) {
    this.mem = mem;
    // Reuse the memory's shared refCount buffer if present, so the same SAB is
    // exported to workers; otherwise create a fresh one and attach it to the
    // memory so it can be shared.
    this.buffer =
      buffer ??
      (mem.refCountBuffer !== null
        ? new RefCountBuffer(mem.refCountBuffer)
        : (() => {
            const b = new RefCountBuffer();
            mem.attachRefCountBuffer(b.sab);
            return b;
          })());
    this.defragThreshold = opts.defragThreshold ?? 0.1;
    // Start periodic maintenance automatically so refcount events are drained
    // and dead space is reclaimed without an explicit call.
    if (opts.autoMaintenance ?? true) {
      this.startAutoMaintenance(opts.maintenanceInterval ?? 100);
    }
  }

  get sab(): SharedArrayBuffer {
    return this.buffer.sab;
  }

  /** Register a worker and attach a close listener that frees its refs. */
  registerWorker(worker: {
    onclose?: (() => void) | null;
    addEventListener?: (type: string, fn: () => void) => void;
  }): number {
    const workerId = this.nextWorkerId++;
    this.workerRefs.set(workerId, new Set());
    const release = () => this.releaseWorker(workerId);
    if (typeof worker.addEventListener === "function") {
      worker.addEventListener("close", release);
    } else if (worker.onclose !== undefined) {
      worker.onclose = release;
    }
    return workerId;
  }

  /**
   * Automatically register workers as they are created.
   *
   * In Bun, `process.on("worker", ...)` fires whenever a Worker is created in
   * this process, passing the Worker instance. This lets the coordinator track
   * every worker without the caller manually calling `registerWorker`. The
   * worker's `onclose` handler is set to release all of its references on
   * close/crash.
   *
   * Returns a function that removes the listener.
   */
  autoRegister(): () => void {
    const listener = (worker: { onclose?: (() => void) | null }) => {
      this.registerWorker(worker);
    };
    process.on("worker", listener);
    return () => {
      process.off("worker", listener);
    };
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

  /** Read the global refcount for an objectId. */
  refCount(objectId: number): number {
    return this.buffer.refCount(objectId);
  }

  /** Drain pending acquire/release events from the ring buffer. */
  drainEvents(): void {
    let ev: RefEvent | null;
    while ((ev = this.buffer.popEvent()) !== null) {
      if (ev.op === 1) this.acquire(ev.objectId, ev.workerId);
      else this.release(ev.objectId, ev.workerId);
    }
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

  /**
   * Start periodic maintenance on the main thread.
   *
   * Every `intervalMs` milliseconds this:
   *   1. drains pending acquire/release events from the ring buffer, and
   *   2. runs a defragmentation pass if any table has less than
   *      `defragThreshold` free space.
   *
   * This is what actually reclaims SAB memory: without it, refcount events
   * accumulate unprocessed and dead space is never compacted. Returns a
   * function that stops the timer.
   */
  startAutoMaintenance(intervalMs = 100): () => void {
    if (this.maintenanceTimer !== null) return () => {};
    this.maintenanceTimer = setInterval(() => {
      this.drainEvents();
      if (this.needsDefrag()) {
        this.mem.withLock(() => this.mem.defragment());
      }
    }, intervalMs);
    // Unref the timer so it does not keep the process alive. The coordinator
    // keeps draining events and defragmenting while the process runs, but the
    // process can still exit naturally when no other work is pending.
    (this.maintenanceTimer as unknown as { unref?: () => void }).unref?.();
    return () => this.stopAutoMaintenance();
  }

  /** Stop the periodic maintenance timer, if running. */
  stopAutoMaintenance(): void {
    if (this.maintenanceTimer !== null) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
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
      this.buffer.pushEvent(this.workerId, 0, objectId);
    });
  }

  /** Register a returned JS object/array so its ref is released on GC. */
  track(value: object, objectId: number): void {
    this.buffer.pushEvent(this.workerId, 1, objectId);
    this.registry.register(value, objectId);
  }

  /** Periodically called by the worker to signal it is alive. */
  heartbeat(): void {
    this.buffer.heartbeat(this.workerId);
  }
}
