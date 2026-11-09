import { supportsWorkerEvents } from "./env.ts";
import type { SharedMemory } from "./memory.ts";

/** New chunk lists handed to workers after a defragmentation pass. */
export interface ChunkLists {
  indexTable: SharedArrayBuffer[];
  dataTable: SharedArrayBuffer[];
  stringTable: SharedArrayBuffer[];
  arrayTable: SharedArrayBuffer[];
}

export interface CoordinatorOptions {
  /**
   * A table counts as fragmented once its used length exceeds this fraction of
   * its capacity (default 0.8).
   */
  defragThreshold?: number;
  /** Start the periodic maintenance timer on construction (default true). */
  autoMaintenance?: boolean;
  /** Maintenance interval in milliseconds (default 100). */
  maintenanceInterval?: number;
  /**
   * Called when the coordinator force-released a lock because the worker that
   * held it died (see `setWorkerThreadId`). The data that worker was modifying
   * may be inconsistent.
   */
  onLockRecovered?: (workerId: number, threadId: number) => void;
  /** Called after a defragmentation pass with the new chunk lists. */
  onDefragment?: (buffers: ChunkLists) => void;
}

/**
 * Main-thread coordinator. It does two jobs:
 *
 * - **Defragmentation.** Writes bump-allocate and never reuse space, so dead
 *   blocks accumulate. A periodic check (and the memory's `reclaimHook`, used
 *   when a write runs out of budget) compacts all tables under every lock.
 * - **Dead-worker recovery.** When a registered worker closes, the locks it
 *   was holding (identified by its lock-owner thread id) are force-released so
 *   other threads do not have to wait for a timeout.
 */
export class MaintenanceCoordinator {
  private readonly mem: SharedMemory;
  private readonly defragThreshold: number;
  private readonly onDefragment?: (buffers: ChunkLists) => void;
  private readonly onLockRecovered?: (
    workerId: number,
    threadId: number,
  ) => void;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private nextWorkerId = 1;
  /** Lock-owner thread id of each worker (see `setWorkerThreadId`). */
  private readonly threadIdByWorker = new Map<number, number>();
  /** workerId -> the worker object it belongs to. */
  private readonly workerById = new Map<number, unknown>();

  constructor(mem: SharedMemory, opts: CoordinatorOptions = {}) {
    this.mem = mem;
    this.onDefragment = opts.onDefragment;
    this.onLockRecovered = opts.onLockRecovered;
    this.defragThreshold = opts.defragThreshold ?? 0.8;
    this.mem.reclaimHook = () => this.runDefrag();
    if (opts.autoMaintenance ?? true) {
      this.startAutoMaintenance(opts.maintenanceInterval ?? 100);
    }
  }

  /**
   * Register a worker and release its locks when it closes. Returns the id
   * assigned to the worker (pass it to `setWorkerThreadId`).
   */
  registerWorker(worker: {
    onclose?: (() => void) | null;
    addEventListener?: (type: string, fn: () => void) => void;
  }): number {
    const id = this.nextWorkerId++;
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
   * Register workers as they are created. In Bun `process.on("worker", ...)`
   * fires for every Worker of this process. Elsewhere this is a no-op (use
   * `acceptWorker()` / `spawnWorker()`). Returns a function that removes the
   * listener.
   */
  autoRegister(): () => void {
    if (!supportsWorkerEvents) return () => {};
    const listener = (worker: { onclose?: (() => void) | null }) => {
      this.registerWorker(worker);
    };
    process.on("worker", listener);
    return () => {
      process.off("worker", listener);
    };
  }

  /**
   * Record the lock-owner thread id (`getThreadId()`) of a worker, so that if
   * the worker dies while holding a lock the coordinator can release it
   * instead of leaving every other thread to time out.
   */
  setWorkerThreadId(workerId: number, threadId: number): void {
    if (typeof threadId === "number" && threadId !== 0) {
      this.threadIdByWorker.set(workerId, threadId);
    }
  }

  /**
   * Forget a worker (by id or by the object passed to `registerWorker`) and
   * release any lock it still holds. Called automatically on `close`; call it
   * yourself when you know a worker was terminated (Bun does not fire `close`
   * for `worker.terminate()`).
   */
  unregisterWorker(worker: unknown | number): void {
    const id = typeof worker === "number" ? worker : this.idForWorker(worker);
    if (id === undefined || !this.workerById.has(id)) return;
    this.workerById.delete(id);
    const threadId = this.threadIdByWorker.get(id);
    this.threadIdByWorker.delete(id);
    if (threadId !== undefined && this.mem.forceUnlockAll(threadId)) {
      this.onLockRecovered?.(id, threadId);
    }
  }

  private idForWorker(worker: unknown): number | undefined {
    for (const [id, w] of this.workerById) {
      if (w === worker) return id;
    }
    return undefined;
  }

  /**
   * Whether any table is full enough to warrant a defragmentation pass.
   *
   * Overwriting a value allocates a new block and leaves the old one as dead
   * space (there is no free list), so the used length only grows. A table
   * triggers a pass when its used length exceeds `defragThreshold` of its
   * capacity.
   */
  needsDefrag(): boolean {
    const frag = (b: { capacity: number; byteLength: number }) =>
      b.capacity !== 0 && b.byteLength / b.capacity > this.defragThreshold;
    return (
      frag(this.mem.dataTable) ||
      frag(this.mem.arrayTable) ||
      frag(this.mem.stringTable)
    );
  }

  /**
   * Start periodic maintenance: every `intervalMs` a defragmentation pass runs
   * if `needsDefrag()`. The timer is unref'd, so it never keeps the process
   * alive. Returns a function that stops it.
   */
  startAutoMaintenance(intervalMs = 100): () => void {
    if (this.maintenanceTimer !== null) return () => {};
    this.maintenanceTimer = setInterval(() => {
      if (this.needsDefrag()) this.runDefrag();
    }, intervalMs);
    (this.maintenanceTimer as unknown as { unref?: () => void }).unref?.();
    return () => this.stopAutoMaintenance();
  }

  /**
   * Compact all tables now and notify `onDefragment` with the new chunk lists.
   * Also installed as the memory's `reclaimHook`, so a write that exhausts the
   * budget reclaims dead space immediately instead of waiting for the timer.
   */
  runDefrag(): void {
    // Takes every key stripe and the global mutex: waits for in-flight writes
    // and blocks new ones while the tables are compacted.
    const buffers = this.mem.withAllLocks(() => this.mem.defragment());
    this.onDefragment?.(buffers);
  }

  /** Stop the periodic maintenance timer, if running. */
  stopAutoMaintenance(): void {
    if (this.maintenanceTimer !== null) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }
}
