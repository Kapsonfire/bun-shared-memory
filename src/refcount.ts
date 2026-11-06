import { supportsWorkerEvents } from "./env.ts";
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
 *   [0]          write index (producer, workers, reserved atomically)
 *   [1]          read index (consumer, main thread)
 *   [2]          (reserved, unused)
 *   [3..]        ring buffer of events (workerId, op, objectId, seq per slot)
 *   [ringEnd..]   worker id bitmap (ceil(maxWorkers/32) words; bit = id in use)
 *   [workerBitsEnd..] heartbeat table (one cell per worker)
 *   [hbEnd..]     global refcount table (one cell per objectId)
 *
 * The ring is a bounded MPSC queue (multiple producers, single consumer).
 * Each 4-Int32 slot carries a `seq` cell used for two things:
 *   - Slot reservation is done atomically by `Atomics.add`ing the write
 *     pointer, so every producer gets a globally unique slot position —
 *     two producers can never claim the same slot (fixes lost/collided
 *     events).
 *   - The producer publishes the slot by advancing `seq` to `pos + 1` (a
 *     release), and the consumer only reads a slot whose `seq` is exactly
 *     `pos + 1`, so a slot is never observed half-written (no torn events).
 *   - After consuming, the consumer re-arms the slot for the next
 *     revolution by setting `seq` to `pos + ringSize`, so the slot is not
 *     overwritten by a producer before the consumer has drained it.
 */
export class RefCountBuffer {
  readonly buffer: SharedArrayBuffer;
  private readonly view: Int32Array;
  private readonly ringSize: number;
  private readonly hbOffset: number;
  private readonly workerBitsOffset: number;
  private readonly workerBitsWords: number;
  private readonly refOffset: number;
  private readonly maxWorkers: number;

  constructor(
    buffer?: SharedArrayBuffer,
    opts: { ringSize?: number; maxWorkers?: number; maxObjects?: number } = {},
  ) {
    const ringSize = opts.ringSize ?? 1024;
    const maxWorkers = opts.maxWorkers ?? 64;
    const maxObjects = opts.maxObjects ?? 1 << 16;
    this.ringSize = ringSize;
    this.maxWorkers = maxWorkers;
    this.workerBitsOffset = 3 + ringSize * 4;
    this.workerBitsWords = Math.ceil(maxWorkers / 32);
    this.hbOffset = this.workerBitsOffset + this.workerBitsWords;
    this.refOffset = this.hbOffset + maxWorkers;
    const total = this.refOffset + maxObjects;
    this.buffer =
      buffer ?? new SharedArrayBuffer(total * Int32Array.BYTES_PER_ELEMENT);
    this.view = new Int32Array(this.buffer);
    // The sequence cells are only initialized when this instance owns a
    // freshly-created SharedArrayBuffer. Instances that wrap an existing
    // buffer (workers, or a coordinator reusing the memory's buffer) must not
    // reset the ring — the buffer's original creator already initialized it.
    if (buffer === undefined) {
      for (let i = 0; i < ringSize; i++) {
        // Slot i is initially ready for the producer at global position i.
        Atomics.store(this.view, 3 + i * 4 + 3, i);
      }
    }
  }

  /** The underlying SharedArrayBuffer, for sharing with other threads. */
  get sab(): SharedArrayBuffer {
    return this.buffer;
  }

  /**
   * Allocate a worker id (worker side). Each worker calls this once to obtain
   * its id, which it uses for heartbeats and events.
   *
   * Worker ids are drawn from a fixed pool of `maxWorkers` slots (a bitmap
   * stored in shared memory). Released ids are reused by later workers, so the
   * id space never grows unboundedly. When every slot is in use the pool is
   * exhausted and this throws an `Error` — a hard failure rather than silently
   * wrapping, which would alias two live workers' heartbeats/events.
   */
  allocateWorkerId(): number {
    for (let attempt = 0; attempt < this.workerBitsWords; attempt++) {
      const word = Atomics.load(this.view, this.workerBitsOffset + attempt);
      const freeBits = ~word & 0xffffffff;
      if (freeBits !== 0) {
        // Lowest free bit: isolate the least-significant zero of `word`.
        const bit = 31 - Math.clz32(freeBits & -freeBits);
        const mask = 1 << bit;
        const old = Atomics.compareExchange(
          this.view,
          this.workerBitsOffset + attempt,
          word,
          word | mask,
        );
        if (old === word) {
          const id = attempt * 32 + bit;
          if (id >= this.maxWorkers)
            throw new Error("worker id pool exhausted");
          return id;
        }
        // Lost the race, re-scan the same word.
        attempt--;
      }
    }
    throw new Error("worker id pool exhausted");
  }

  /**
   * Release a worker id back to the free pool so it can be reused (coordinator
   * side). Idempotent: releasing an already-free id is a no-op.
   */
  releaseWorkerId(workerId: number): void {
    if (workerId < 0 || workerId >= this.maxWorkers) return;
    const word = workerId >>> 5;
    const bit = workerId & 31;
    Atomics.and(this.view, this.workerBitsOffset + word, ~(1 << bit));
  }

  /**
   * Append an acquire/release event to the ring buffer (worker side).
   *
   * Safe for multiple concurrent producers: the output slot is reserved with
   * an atomic `add` on the write pointer, so each producer gets a unique
   * position and two producers can never write the same slot. When the ring
   * is full, the producer blocks until the consumer re-arms a slot, rather
   * than silently dropping the event — a lost acquire/release would corrupt
   * the refcount and leak or prematurely free an object.
   */
  pushEvent(workerId: number, op: 0 | 1, objectId: number): void {
    // Atomically reserve the next output position (old value = our position).
    const pos = Atomics.add(this.view, 0, 1);
    const slot = pos % this.ringSize;
    const seqIdx = 3 + slot * 4 + 3;
    // Wait until the consumer has re-armed this slot. The slot is free for
    // the producer at global position `pos` when its seq equals `pos`. If the
    // ring is full, the consumer has not re-armed it yet and we block until
    // it does (the user signals it via Atomics.notify after re-arming).
    let seq = Atomics.load(this.view, seqIdx);
    while (seq !== pos) {
      Atomics.wait(this.view, seqIdx, seq);
      seq = Atomics.load(this.view, seqIdx);
    }
    const base = 3 + slot * 4;
    // Fill the slot, then publish it. The closing seq store is a release:
    // the consumer re-checks seq === pos + 1 before reading the slot, so it
    // can never observe a partially-written event.
    Atomics.store(this.view, base, workerId);
    Atomics.store(this.view, base + 1, op);
    Atomics.store(this.view, base + 2, objectId);
    Atomics.store(this.view, seqIdx, pos + 1);
  }

  /**
   * Pop the next event, or null if the queue is empty (main thread side).
   *
   * Only the main thread consumes. It reads the slot at the current read
   * position only once that slot's seq has advanced to `pos + 1` (i.e. the
   * producer has finished writing), then re-arms the slot for the next
   * revolution and wakes any producer blocked on a full ring.
   */
  popEvent(): RefEvent | null {
    const read = Atomics.load(this.view, 1);
    const slot = read % this.ringSize;
    const seqIdx = 3 + slot * 4 + 3;
    // The event at this position is only ready once its seq is exactly
    // `read + 1`. A value of `read` (or less) means the producer has not
    // published it yet.
    if (Atomics.load(this.view, seqIdx) !== read + 1) return null;
    const base = 3 + slot * 4;
    const workerId = Atomics.load(this.view, base);
    const op = Atomics.load(this.view, base + 1) as 0 | 1;
    const objectId = Atomics.load(this.view, base + 2);
    // Re-arm the slot for the producer at global position `read + ringSize`
    // (which maps to this same ring slot), then advance the read pointer and
    // wake any producer waiting for space.
    Atomics.store(this.view, seqIdx, read + this.ringSize);
    Atomics.store(this.view, 1, read + 1);
    Atomics.notify(this.view, seqIdx, Infinity);
    return { workerId, op, objectId };
  }

  /**
   * Update this worker's heartbeat cell. Uses a monotonic counter that fits in
   * an Int32 (Date.now() overflows Int32), so the main thread can detect a
   * worker that stopped heartbeating.
   */
  heartbeat(workerId: number): void {
    if (workerId < 0 || workerId >= this.maxWorkers) return;
    const prev = Atomics.load(this.view, this.hbOffset + workerId);
    Atomics.store(this.view, this.hbOffset + workerId, prev + 1);
  }

  /** Read a worker's last heartbeat timestamp. */
  lastHeartbeat(workerId: number): number {
    if (workerId < 0 || workerId >= this.maxWorkers) return 0;
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
  /** workerId -> the worker object it belongs to (for reverse/explicit reaping). */
  private readonly workerById = new Map<number, unknown>();
  /** workerId -> heartbeat counter last observed by the coordinator. */
  private readonly heartbeatSeen = new Map<number, number>();
  /** workerId -> number of consecutive maintenance ticks without a heartbeat. */
  private readonly heartbeatMisses = new Map<number, number>();
  /**
   * After this many consecutive maintenance ticks with no heartbeat advance a
   * worker is considered dead and its refs are released. `0`/undefined
   * disables automatic heartbeat reaping.
   */
  private readonly heartbeatTicks: number;
  /** Free-space threshold (fraction of maxByteLength) that triggers defrag. */
  private readonly defragThreshold: number;
  /** Minimum number of freed blocks before a table is considered fragmented. */
  private readonly minFreeBlocks: number;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  /** Called after a defragmentation pass with the new chunk lists. */
  private readonly onDefragment?: (buffers: {
    indexTable: SharedArrayBuffer[];
    dataTable: SharedArrayBuffer[];
    stringTable: SharedArrayBuffer[];
    arrayTable: SharedArrayBuffer[];
  }) => void;

  constructor(
    mem: SharedMemory,
    buffer?: RefCountBuffer,
    opts: {
      defragThreshold?: number;
      minFreeBlocks?: number;
      autoMaintenance?: boolean;
      maintenanceInterval?: number;
      /** Consecutive ticks without a heartbeat before a worker is reaped. */
      heartbeatTicks?: number;
      onDefragment?: (buffers: {
        indexTable: SharedArrayBuffer[];
        dataTable: SharedArrayBuffer[];
        stringTable: SharedArrayBuffer[];
        arrayTable: SharedArrayBuffer[];
      }) => void;
    } = {},
  ) {
    this.mem = mem;
    this.onDefragment = opts.onDefragment;
    this.heartbeatTicks = opts.heartbeatTicks ?? 0;
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
    this.defragThreshold = opts.defragThreshold ?? 0.8;
    this.minFreeBlocks = opts.minFreeBlocks ?? 64;
    // Start periodic maintenance automatically so refcount events are drained
    // and dead space is reclaimed without an explicit call.
    if (opts.autoMaintenance ?? true) {
      this.startAutoMaintenance(opts.maintenanceInterval ?? 100);
    }
  }

  get sab(): SharedArrayBuffer {
    return this.buffer.sab;
  }

  /**
   * Register a worker and attach a close listener that frees its refs.
   *
   * The workerId is assigned by the shared refcount buffer itself
   * (`allocateWorkerId()`), so it is the same id the worker uses for its own
   * events and heartbeats. Pass an explicit `workerId` when the worker already
   * allocated one (e.g. reconstructed from a handshake).
   *
   * Returns the workerId assigned to the worker.
   */
  registerWorker(
    worker: {
      onclose?: (() => void) | null;
      addEventListener?: (type: string, fn: () => void) => void;
    },
    workerId?: number,
  ): number {
    const id = workerId ?? this.buffer.allocateWorkerId();
    if (!this.workerRefs.has(id)) {
      this.workerRefs.set(id, new Set());
      // heartbeatSeen is left unset until the first heartbeat is observed, so
      // a worker that has not started heartbeating yet is not reaped.
    }
    this.workerById.set(id, worker);
    const release = () => this.unregisterWorker(id);
    if (typeof worker.addEventListener === "function") {
      worker.addEventListener("close", release);
    } else if (worker.onclose !== undefined) {
      worker.onclose = release;
    }
    return id;
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
   * On the browser main thread there is no `process.on("worker", ...)`, so
   * this returns a no-op; instead, workers created via `acceptWorker()` /
   * `spawnWorker()` are registered there.
   *
   * Returns a function that removes the listener.
   */
  autoRegister(): () => void {
    if (!supportsWorkerEvents) {
      return () => {};
    }
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

  /**
   * Release the references of any registered worker that was observed
   * heartbeating and then stopped for `heartbeatTicks` consecutive maintenance
   * cycles.
   *
   * Called automatically by the maintenance timer when heartbeat reaping is
   * enabled (`heartbeatTicks > 0`). This detects a dead/terminated worker
   * without a `close` event — relevant in the browser, which has neither
   * `process.on("worker")` nor a reliable per-worker `close` event.
   *
   * A worker that never heartbeated is treated as alive and is NOT reaped here;
   * use `unregisterWorker()` as the explicit backstop for those.
   */
  reapDeadWorkers(): void {
    for (const workerId of [...this.workerRefs.keys()]) {
      const seen = this.heartbeatSeen.get(workerId);
      const now = this.buffer.lastHeartbeat(workerId);
      if (seen === undefined) {
        // Not observed alive yet. If it has actually heartbeated, record that
        // so later stalls can be reaped; otherwise skip (may still be
        // starting up / never heartbeats -> left to explicit unregister).
        if (now > 0) {
          this.heartbeatSeen.set(workerId, now);
        }
        continue;
      }
      if (now === seen) {
        const misses = (this.heartbeatMisses.get(workerId) ?? 0) + 1;
        this.heartbeatMisses.set(workerId, misses);
        if (this.heartbeatTicks > 0 && misses >= this.heartbeatTicks) {
          this.releaseWorker(workerId);
          this.unregisterWorker(workerId);
        }
      } else {
        this.heartbeatSeen.set(workerId, now);
        this.heartbeatMisses.delete(workerId);
      }
    }
  }

  /**
   * Forcibly unregister a worker (by workerId or by the worker object passed to
   * `registerWorker`), releasing any refs it still holds.
   *
   * This is the explicit backstop to heartbeat reaping — call it when you know
   * a worker has terminated and want its refs freed immediately.
   */
  unregisterWorker(worker: unknown | number): void {
    const id = typeof worker === "number" ? worker : this.idForWorker(worker);
    if (id === undefined) return;
    if (!this.workerById.has(id) && !this.workerRefs.has(id)) {
      // Already fully unregistered (e.g. close event then heartbeat reap).
      return;
    }
    this.releaseWorker(id);
    this.workerRefs.delete(id);
    this.workerById.delete(id);
    this.heartbeatSeen.delete(id);
    this.heartbeatMisses.delete(id);
    // Return the worker id to the free pool so it can be reused. Releasing an
    // already-free id is a no-op, so re-entrant cleanup is safe.
    this.buffer.releaseWorkerId(id);
  }

  /** Map a worker object back to its workerId, if registered. */
  private idForWorker(worker: unknown): number | undefined {
    for (const [id, w] of this.workerById) {
      if (w === worker) return id;
    }
    return undefined;
  }

  /**
   * Whether any table is highly fragmented enough to warrant a defragmentation
   * pass.
   *
   * Writes are lock-free bump allocations: overwriting a value allocates a new
   * block and leaves the old one as dead space (there is no free list to reuse
   * it). The used length therefore grows monotonically even when the live data
   * set stays the same size. When the used length occupies a significant share
   * of the buffer's capacity, a defragmentation pass is warranted to compact
   * the live data and reclaim the dead space.
   *
   * A table triggers defrag when its used length exceeds `defragThreshold` of
   * the buffer's capacity.
   */
  needsDefrag(): boolean {
    const frag = (b: { capacity: number; byteLength: number }) => {
      if (b.capacity === 0) return false;
      return b.byteLength / b.capacity > this.defragThreshold;
    };
    return (
      frag(this.mem.dataTable) ||
      frag(this.mem.arrayTable) ||
      frag(this.mem.stringTable)
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
      if (this.heartbeatTicks > 0) this.reapDeadWorkers();
      if (this.needsDefrag()) {
        // Set the defrag flag so lock-free writes fall back to the mutex, then
        // wait for any in-flight lock-free writes to finish before compacting.
        this.mem.setDefragmenting();
        this.mem.waitForWritesToFinish();
        const buffers = this.mem.withLock(() => this.mem.defragment());
        this.mem.clearDefragmenting();
        this.onDefragment?.(buffers);
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

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start sending periodic heartbeats so the main-thread coordinator can
   * detect this worker is still alive.
   *
   * Needed when the worker may terminate without a `close` event reaching the
   * coordinator — most importantly in the browser (Web Workers have no
   * `process.on("worker")` and no reliable per-worker `close` event). Returns a
   * stop function.
   */
  startHeartbeat(intervalMs = 1000): () => void {
    if (this.heartbeatTimer !== null) return () => {};
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs);
    return () => this.stopHeartbeat();
  }

  /** Stop the periodic heartbeat, if running. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
