/**
 * Shared memory budget shared across multiple GrowableBuffers.
 *
 * Tracks the combined physical size of DataTable, StringTable, and ArrayTable.
 * The counter is shared across workers so each growth reserves against the
 * same limit.
 */
export class SharedBudget {
  private readonly used: BigInt64Array;

  constructor(
    private readonly max: number,
    buffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
  ) {
    this.used = new BigInt64Array(buffer);
  }

  get buffer(): SharedArrayBuffer {
    return this.used.buffer as SharedArrayBuffer;
  }

  /** Record a buffer's initial physical size. */
  add(size: number): void {
    if (!this.tryReserve(size)) {
      const total = Atomics.load(this.used, 0) + BigInt(size);
      throw new RangeError(
        `Shared memory budget exceeded: initial buffers total ${total} bytes but the budget is ${this.max}`,
      );
    }
  }

  /**
   * Atomically reserve physical memory shared by all tables and workers.
   */
  tryReserve(size: number): boolean {
    if (size <= 0) return true;
    const increment = BigInt(size);
    for (;;) {
      const current = Atomics.load(this.used, 0);
      if (current + increment > BigInt(this.max)) return false;
      if (
        Atomics.compareExchange(this.used, 0, current, current + increment) ===
        current
      ) {
        return true;
      }
    }
  }

  /**
   * Release memory reserved for a growth that failed or a reclaimed chunk.
   */
  release(size: number): void {
    if (size <= 0) return;
    const decrement = BigInt(size);
    for (;;) {
      const current = Atomics.load(this.used, 0);
      const next = current > decrement ? current - decrement : 0n;
      if (Atomics.compareExchange(this.used, 0, current, next) === current) {
        return;
      }
    }
  }
}

/**
 * Growable shared memory backed by one or more SharedArrayBuffers. Chunked
 * tables split storage across SABs; the Index Table uses one growable SAB.
 * Offsets are logical and continuous across chunks.
 *
 * In chunked mode, all chunks are pre-allocated with `maxByteLength =
 * chunkSize` but only 4 bytes of actual storage. A chunk is activated (grown
 * to its full size) on first access. Because `SharedArrayBuffer.grow()` is
 * visible across workers, activation needs no postMessage broadcast.
 */
interface Chunk {
  buffer: SharedArrayBuffer;
  view: DataView;
  /** Whether the chunk has been grown to its full size. */
  active: boolean;
}

/** Round `n` up to the next power of two (chunk sizes must be powers of two). */
export function nextPowerOfTwo(n: number): number {
  if (n <= 0) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function largestPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  return 2 ** Math.floor(Math.log2(n));
}

/**
 * Minimum size of a slab-allocated block. The free-list metadata written by
 * `free` (next pointer + size = 8 bytes) must fit inside the block, otherwise
 * it would overwrite the following block. All blocks are padded up to at
 * least this size.
 */
const MIN_BLOCK_SIZE = 8;

export { MIN_BLOCK_SIZE };

export class GrowableBuffer {
  private chunks: Chunk[] = [];
  private readonly maxByteLength: number;
  private readonly singleBuffer: boolean;
  /** Fixed size of every chunk (the minimum growth step). */
  readonly chunkSize: number;
  /** log2(chunkSize), used for O(1) offset resolution via bit shifts. */
  private readonly chunkShift: number;
  private readonly budget?: SharedBudget;
  /**
   * Shared append cursor (used length). Stored in a SharedArrayBuffer so all
   * workers that reconstruct this buffer from `fromBuffers()` see the same
   * used length and append at the correct offset instead of overwriting
   * existing data at offset 0.
   */
  private readonly cursor: BigInt64Array;
  /**
   * Shared head of the free list. Stored in a SharedArrayBuffer so all workers
   * that reconstruct this buffer from `fromBuffers()` see the same free list
   * and reuse freed blocks instead of appending at the end.
   *
   * The free list is a singly-linked list of freed blocks. Each freed block
   * stores, in its first 4 bytes, the byte offset of the next free block (or
   * -1 for the end of the list). The head is the offset of the first free
   * block, or -1 when the list is empty.
   */
  private readonly freeListHead: Int32Array;
  /** Smallest chunk index that is not yet active (see `activate`). */
  private nextChunkToActivate = 0;

  constructor(
    initialSizeOrBuffer: number | SharedArrayBuffer | SharedArrayBuffer[],
    maxByteLength: number,
    budget?: SharedBudget,
    chunkSize = 32 * 1024 * 1024, // 32 MiB per chunk
    singleBuffer = false,
    chargeInitial = true,
    cursorBuffer?: SharedArrayBuffer,
    freeListBuffer?: SharedArrayBuffer,
  ) {
    this.singleBuffer = singleBuffer;
    this.budget = budget;
    this.cursor = new BigInt64Array(
      cursorBuffer ?? new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
    );
    this.freeListHead = new Int32Array(
      freeListBuffer ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    );
    // Initialize the free list head to -1 (empty) on first construction.
    if (freeListBuffer === undefined) {
      Atomics.store(this.freeListHead, 0, -1);
    }
    if (singleBuffer && typeof initialSizeOrBuffer !== "number") {
      const buffer = Array.isArray(initialSizeOrBuffer)
        ? initialSizeOrBuffer[0]
        : initialSizeOrBuffer;
      if (
        buffer === undefined ||
        (Array.isArray(initialSizeOrBuffer) && initialSizeOrBuffer.length !== 1)
      ) {
        throw new RangeError(
          "A single-buffer GrowableBuffer requires exactly one SharedArrayBuffer",
        );
      }
      this.maxByteLength = Math.min(
        buffer.maxByteLength ?? buffer.byteLength,
        maxByteLength,
      );
      this.chunkSize = this.maxByteLength;
      this.chunkShift = 0;
      this.chunks.push({
        buffer,
        view: new DataView(buffer),
        active: buffer.byteLength > 4,
      });
      if (chargeInitial) this.budget?.add(buffer.byteLength);
      return;
    }

    this.maxByteLength = maxByteLength;
    if (typeof initialSizeOrBuffer === "number") {
      if (singleBuffer) {
        const buffer = new SharedArrayBuffer(4, {
          maxByteLength,
        });
        this.chunkSize = maxByteLength;
        this.chunkShift = 0;
        this.chunks.push({
          buffer,
          view: new DataView(buffer),
          active: false,
        });
        return;
      }
      this.chunkSize = Math.min(
        nextPowerOfTwo(chunkSize),
        largestPowerOfTwo(maxByteLength),
      );
      this.chunkShift = Math.log2(this.chunkSize);
      // Pre-allocate all chunks (4 bytes each, growable to chunkSize).
      const chunkCount = Math.max(1, Math.ceil(maxByteLength / this.chunkSize));
      for (let i = 0; i < chunkCount; i++) {
        const buffer = new SharedArrayBuffer(4, {
          maxByteLength: this.chunkSize,
        });
        this.chunks.push({
          buffer,
          view: new DataView(buffer),
          active: false,
        });
        if (chargeInitial) this.budget?.add(buffer.byteLength);
      }
    } else if (Array.isArray(initialSizeOrBuffer)) {
      // Reconstruct from a list of chunks. Use the buffers directly (they are
      // already shared via postMessage) so writes are visible across workers.
      // All chunks are pre-allocated at 4 bytes with maxByteLength = chunkSize;
      // the chunk size is derived from each buffer's maxByteLength (which is
      // preserved across postMessage), not its current byteLength.
      this.chunkSize = initialSizeOrBuffer[0]?.maxByteLength ?? chunkSize;
      this.chunkShift = Math.log2(this.chunkSize);
      for (const sab of initialSizeOrBuffer) {
        this.chunks.push({
          buffer: sab,
          view: new DataView(sab),
          active: sab.byteLength === this.chunkSize,
        });
        if (chargeInitial) this.budget?.add(sab.byteLength);
      }
    } else {
      // Reconstruct from a single existing buffer. Use it directly so writes
      // are shared. Its size defines the chunk size (prefer maxByteLength so
      // a pre-allocated 4-byte chunk is interpreted at its full size).
      this.chunkSize =
        initialSizeOrBuffer.maxByteLength ?? initialSizeOrBuffer.byteLength;
      this.chunkShift = Math.log2(this.chunkSize);
      this.chunks.push({
        buffer: initialSizeOrBuffer,
        view: new DataView(initialSizeOrBuffer),
        active: initialSizeOrBuffer.byteLength === this.chunkSize,
      });
      if (chargeInitial) this.budget?.add(initialSizeOrBuffer.byteLength);
    }
  }

  /**
   * Activate the chunk at `index` by growing it to its full size. Because
   * `SharedArrayBuffer.grow()` is visible across all workers, no broadcast is
   * needed. No-op if the chunk is already active.
   */
  private activate(index: number): void {
    const chunk = this.chunks[index];
    if (chunk === undefined || chunk.active) return;
    if (this.singleBuffer) {
      return;
    }
    const oldSize = chunk.buffer.byteLength;
    if (oldSize >= this.chunkSize) {
      chunk.view = new DataView(chunk.buffer);
      chunk.active = true;
      this.advanceNextChunkToActivate(index);
      return;
    }
    const growth = this.chunkSize - oldSize;
    if (this.budget && !this.budget.tryReserve(growth)) {
      throw new RangeError(
        `Shared memory budget exceeded: need ${growth} additional bytes`,
      );
    }
    try {
      chunk.buffer.grow(this.chunkSize);
    } catch (error) {
      if (chunk.buffer.byteLength >= this.chunkSize) {
        this.budget?.release(growth);
        chunk.view = new DataView(chunk.buffer);
        chunk.active = true;
        this.advanceNextChunkToActivate(index);
        return;
      }
      this.budget?.release(growth);
      throw error;
    }
    chunk.view = new DataView(chunk.buffer);
    chunk.active = true;
    this.advanceNextChunkToActivate(index);
  }

  /**
   * Advance `nextChunkToActivate` past `index` while the following chunks are
   * already active, so `ensureCapacity` never re-scans active chunks.
   */
  private advanceNextChunkToActivate(index: number): void {
    if (index < this.nextChunkToActivate) return;
    this.nextChunkToActivate = index + 1;
    while (
      this.nextChunkToActivate < this.chunks.length &&
      this.chunks[this.nextChunkToActivate]!.active
    ) {
      this.nextChunkToActivate++;
    }
  }

  /** Number of bytes written so far (used length, not buffer capacity). */
  get byteLength(): number {
    return Number(Atomics.load(this.cursor, 0));
  }

  /** The shared cursor buffer (for export to workers). */
  get cursorBuffer(): SharedArrayBuffer {
    return this.cursor.buffer as SharedArrayBuffer;
  }

  /** The shared free-list head buffer (for export to workers). */
  get freeListBuffer(): SharedArrayBuffer {
    return this.freeListHead.buffer as SharedArrayBuffer;
  }

  /** Total logical capacity across all chunks (active or not). */
  get capacity(): number {
    return this.singleBuffer
      ? this.maxByteLength
      : this.chunks.length * this.chunkSize;
  }

  /** The list of SharedArrayBuffers backing this buffer (for export). */
  get buffers(): SharedArrayBuffer[] {
    return this.chunks.map((c) => c.buffer);
  }

  /** Number of chunks that have been grown from their initial 4-byte size. */
  get activeChunkCount(): number {
    return this.chunks.reduce((n, c) => n + (c.active ? 1 : 0), 0);
  }

  /**
   * Replace the chunk list with `newBuffers` (received from the main thread
   * after a defragmentation broadcast). Each buffer is either a full-size
   * active chunk or a fresh 4-byte inactive chunk. Used by workers to stay in
   * sync with the main thread's chunk replacement.
   */
  applyChunks(newBuffers: SharedArrayBuffer[]): void {
    if (this.singleBuffer && newBuffers.length !== 1) {
      throw new RangeError(
        "A single-buffer GrowableBuffer requires exactly one SharedArrayBuffer",
      );
    }
    this.chunks = newBuffers.map((sab) => ({
      buffer: sab,
      view: new DataView(sab),
      active: this.singleBuffer
        ? sab.byteLength > 4
        : sab.byteLength === this.chunkSize,
    }));
    this.nextChunkToActivate = this.firstInactiveChunk();
  }

  /**
   * Resolve a logical offset into (chunk, offset within that chunk). All
   * chunks are the same size, so this is O(1). Activates the chunk if it is
   * not yet active.
   */
  private resolve(offset: number): { chunk: Chunk; off: number } {
    if (this.singleBuffer) {
      return { chunk: this.chunks[0]!, off: offset };
    }
    const index = offset >>> this.chunkShift;
    const chunk = this.chunks[index];
    if (chunk === undefined) {
      throw new RangeError(`Offset ${offset} is beyond the buffer capacity`);
    }
    this.activate(index);
    return { chunk, off: offset & (this.chunkSize - 1) };
  }

  /** Ensure the buffer has room for at least `needed` bytes. */
  ensureCapacity(needed: number): void {
    if (needed > this.maxByteLength) {
      throw new RangeError(
        `Shared buffer capacity exceeded: need ${needed} bytes but max is ${this.maxByteLength}`,
      );
    }
    if (this.singleBuffer) {
      const chunk = this.chunks[0]!;
      const oldSize = chunk.buffer.byteLength;
      if (needed <= oldSize) return;
      const target = Math.min(
        this.maxByteLength,
        Math.max(needed, oldSize * 2),
      );
      let growth = target - oldSize;
      if (this.budget && !this.budget.tryReserve(growth)) {
        if (target === needed || !this.budget.tryReserve(needed - oldSize)) {
          throw new RangeError(
            `Shared memory budget exceeded: need ${needed - oldSize} additional bytes`,
          );
        }
        growth = needed - oldSize;
      }
      try {
        chunk.buffer.grow(oldSize + growth);
      } catch (error) {
        this.budget?.release(growth);
        throw error;
      }
      chunk.view = new DataView(chunk.buffer);
      chunk.active = true;
      return;
    }
    // All chunks are pre-allocated; just activate the ones needed to cover
    // `needed`. grow() is visible across workers, so no broadcast is required.
    // Start from `nextChunkToActivate` so already-active chunks are not
    // re-scanned on every write (keeps the write hot path O(1) amortized).
    const neededChunks = Math.ceil(needed / this.chunkSize);
    for (let i = this.nextChunkToActivate; i < neededChunks; i++) {
      this.activate(i);
    }
  }

  /** Mark `n` bytes as used, after writing them at the current offset. */
  advance(n: number): void {
    Atomics.add(this.cursor, 0, BigInt(n));
  }

  /**
   * Atomically reserve `size` bytes at the end of the buffer and return the
   * start offset. This is the lock-free bump-allocation primitive: the shared
   * cursor is incremented with a single `Atomics.add`, so concurrent workers
   * each get a distinct, non-overlapping range without a mutex. The caller
   * writes its data into `[offset, offset + size)`.
   *
   * Chunk growth is preserved: `ensureCapacity` activates any chunks needed to
   * cover the reserved range. Because `SharedArrayBuffer.grow()` is visible
   * across workers, activation needs no broadcast.
   *
   * Unlike `alloc`, this never consults the free list, so freed blocks are not
   * reused on this path (dead space is reclaimed by defragmentation).
   */
  reserve(size: number): number {
    // Lock-free bump allocation with chunk-boundary alignment. The shared
    // cursor is advanced with a compare-exchange loop so concurrent workers
    // each get a distinct, non-overlapping range without a mutex. If the
    // block would cross a chunk boundary, the offset is aligned up to the next
    // chunk so the caller's typed writes (setInt32 etc.) never straddle two
    // chunks (those accessors only write within a single chunk).
    while (true) {
      const current = Number(Atomics.load(this.cursor, 0));
      let offset = current;
      if (!this.singleBuffer) {
        const within = current & (this.chunkSize - 1);
        if (within + size > this.chunkSize) {
          offset = current + (this.chunkSize - within);
        }
      }
      const next = offset + size;
      if (
        Atomics.compareExchange(
          this.cursor,
          0,
          BigInt(current),
          BigInt(next),
        ) === BigInt(current)
      ) {
        this.ensureCapacity(next);
        return offset;
      }
    }
  }

  /**
   * Allocate `size` bytes, reusing a freed block from the free list when one
   * of at least `size` bytes is available (first-fit), otherwise appending at
   * the end of the buffer.
   *
   * Returns the byte offset of the allocated block and the actual reserved
   * (padded) size. The caller must write the block's data and then call
   * `advance(reserved)` only when the block was appended (not reused), because
   * a reused block is already counted as used.
   *
   * @returns the offset, the reserved size, and whether the block was freshly
   *          appended (true) or reused from the free list (false).
   */
  alloc(size: number): { offset: number; appended: boolean; size: number } {
    // Pad small blocks up to MIN_BLOCK_SIZE so the free-list metadata written
    // by `free` always fits inside the block and never overwrites a neighbour.
    size = Math.max(size, MIN_BLOCK_SIZE);
    // First-fit search over the free list for a block of at least `size`.
    let prev = -1;
    let cur = Atomics.load(this.freeListHead, 0);
    while (cur !== -1) {
      const next = this.getInt32(cur);
      if (this.blockSize(cur) >= size) {
        // Unlink `cur` from the free list.
        if (prev === -1) {
          Atomics.store(this.freeListHead, 0, next);
        } else {
          this.setInt32(prev, next);
        }
        return { offset: cur, appended: false, size };
      }
      prev = cur;
      cur = next;
    }
    // No reusable block; append at the end.
    const offset = this.byteLength;
    this.ensureCapacity(offset + size);
    return { offset, appended: true, size };
  }

  /**
   * Free a block previously allocated with `alloc`, pushing it onto the free
   * list so it can be reused. Detects double frees: freeing a block that is
   * already on the free list throws an Error.
   *
   * The block's first 8 bytes are overwritten with the free-list metadata
   * (next pointer + size), so the caller must not read the block's data after
   * freeing it.
   */
  free(offset: number, size: number): void {
    // Pad to MIN_BLOCK_SIZE to match the size `alloc` actually reserved, so
    // `blockSize` reports the real block size for reuse decisions.
    size = Math.max(size, MIN_BLOCK_SIZE);
    // Double-free detection: a block already on the free list must not be
    // freed again. Walk the list (free is not a hot path, so the O(n) scan is
    // acceptable).
    let cur = Atomics.load(this.freeListHead, 0);
    while (cur !== -1) {
      if (cur === offset) {
        throw new Error(
          `Double free detected at offset ${offset} (size ${size})`,
        );
      }
      cur = this.getInt32(cur);
    }
    const head = Atomics.load(this.freeListHead, 0);
    this.setInt32(offset, head);
    this.setInt32(offset + 4, size);
    Atomics.store(this.freeListHead, 0, offset);
  }

  /**
   * Read the size of a freed block, stored in bytes [4..7] when it was
   * freed. Used by `alloc` to check whether a freed block is large enough.
   */
  private blockSize(offset: number): number {
    return this.getInt32(offset + 4);
  }

  /**
   * Walk the free list and return the number of freed blocks and the total
   * bytes they occupy. Used to measure fragmentation: many small freed blocks
   * scattered through the buffer indicate high fragmentation, which a
   * defragmentation pass can compact.
   */
  freeListStats(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    let cur = Atomics.load(this.freeListHead, 0);
    while (cur !== -1) {
      count++;
      bytes += this.blockSize(cur);
      cur = this.getInt32(cur);
    }
    return { count, bytes };
  }

  /**
   * Reset the used length to `n` bytes. Used by defragmentation after
   * compacting live data to the front of the buffer. Chunks beyond the
   * compacted region are marked inactive; their storage is reclaimed by
   * `releaseInactiveChunks()`.
   */
  reset(n: number): void {
    Atomics.store(this.cursor, 0, BigInt(n));
    // After compaction the free list's offsets are invalid (blocks moved), so
    // clear it. Freed blocks are re-added lazily on the next `free`.
    Atomics.store(this.freeListHead, 0, -1);
    if (this.singleBuffer) return;
    const neededChunks = Math.ceil(n / this.chunkSize);
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      chunk.active =
        i < neededChunks && chunk.buffer.byteLength >= this.chunkSize;
    }
    this.nextChunkToActivate = this.firstInactiveChunk();
  }

  /**
   * Replace every inactive chunk with a fresh 4-byte SharedArrayBuffer
   * (growable to `chunkSize`), releasing the old full-size buffer so its
   * memory can be reclaimed. Returns the new chunk list; the caller must
   * broadcast it to workers so they see the replacement.
   *
   * Because a SharedArrayBuffer cannot be shrunk, reclaiming memory requires
   * allocating a new buffer. This is only called after defragmentation (rare),
   * so the resulting broadcast is acceptable.
   */
  releaseInactiveChunks(): SharedArrayBuffer[] {
    if (this.singleBuffer) return this.chunks.map((c) => c.buffer);
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      if (chunk.active) continue;
      // Release the old full-size buffer from the budget and replace it with
      // a fresh 4-byte chunk.
      this.budget?.release(Math.max(0, chunk.buffer.byteLength - 4));
      const buffer = new SharedArrayBuffer(4, {
        maxByteLength: this.chunkSize,
      });
      this.chunks[i] = { buffer, view: new DataView(buffer), active: false };
    }
    this.nextChunkToActivate = this.firstInactiveChunk();
    return this.chunks.map((c) => c.buffer);
  }

  /** Index of the first chunk that is not active, or `chunks.length`. */
  private firstInactiveChunk(): number {
    for (let i = 0; i < this.chunks.length; i++) {
      if (!this.chunks[i]!.active) return i;
    }
    return this.chunks.length;
  }

  // -------------------------------------------------------------------------
  // Typed accessors (resolve offset -> chunk)
  // -------------------------------------------------------------------------

  getInt32(offset: number): number {
    if (this.singleBuffer) return this.chunks[0]!.view.getInt32(offset, true);
    const index = offset >>> this.chunkShift;
    this.activate(index);
    return this.chunks[index]!.view.getInt32(
      offset & (this.chunkSize - 1),
      true,
    );
  }

  setInt32(offset: number, value: number): void {
    if (this.singleBuffer) {
      this.chunks[0]!.view.setInt32(offset, value, true);
      return;
    }
    const index = offset >>> this.chunkShift;
    this.activate(index);
    this.chunks[index]!.view.setInt32(
      offset & (this.chunkSize - 1),
      value,
      true,
    );
  }

  getUint8(offset: number): number {
    if (this.singleBuffer) return this.chunks[0]!.view.getUint8(offset);
    const index = offset >>> this.chunkShift;
    this.activate(index);
    return this.chunks[index]!.view.getUint8(offset & (this.chunkSize - 1));
  }

  setUint8(offset: number, value: number): void {
    if (this.singleBuffer) {
      this.chunks[0]!.view.setUint8(offset, value);
      return;
    }
    const index = offset >>> this.chunkShift;
    this.activate(index);
    this.chunks[index]!.view.setUint8(offset & (this.chunkSize - 1), value);
  }

  /** Read `length` bytes starting at `offset` into a fresh Uint8Array. */
  readBytes(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let pos = offset;
    let outPos = 0;
    while (outPos < length) {
      const { chunk, off } = this.resolve(pos);
      const n = Math.min(length - outPos, this.chunkSize - off);
      out.set(new Uint8Array(chunk.buffer, off, n), outPos);
      outPos += n;
      pos += n;
    }
    return out;
  }

  /** Write `bytes` starting at `offset`. */
  writeBytes(offset: number, bytes: Uint8Array): void {
    let pos = offset;
    let srcPos = 0;
    while (srcPos < bytes.byteLength) {
      const { chunk, off } = this.resolve(pos);
      const n = Math.min(bytes.byteLength - srcPos, this.chunkSize - off);
      new Uint8Array(chunk.buffer, off, n).set(
        bytes.subarray(srcPos, srcPos + n),
      );
      srcPos += n;
      pos += n;
    }
  }
}
