/**
 * Shared memory budget shared across multiple GrowableBuffers.
 *
 * Tracks the sum of the physical sizes of all participating buffers so a
 * caller can cap the *total* memory used by a set of buffers, rather than
 * capping each buffer independently. Growth is only allowed if the new total
 * stays within the budget.
 */
export class SharedBudget {
  private total = 0;

  constructor(private readonly max: number) {}

  /** Record a buffer's initial physical size. */
  add(size: number): void {
    this.total += size;
    if (this.total > this.max) {
      throw new RangeError(
        `Shared memory budget exceeded: initial buffers total ${this.total} bytes but the budget is ${this.max}`,
      );
    }
  }

  /**
   * Attempt to grow a buffer from `oldSize` to `newSize`. Returns true and
   * updates the total if the new total stays within the budget, false
   * otherwise (the caller must not grow).
   */
  tryGrow(oldSize: number, newSize: number): boolean {
    const newTotal = this.total - oldSize + newSize;
    if (newTotal > this.max) return false;
    this.total = newTotal;
    return true;
  }

  /**
   * Release `size` bytes from the budget (e.g. when a chunk is replaced by a
   * smaller one). The total never goes below zero.
   */
  release(size: number): void {
    this.total = Math.max(0, this.total - size);
  }
}

/**
 * Growable shared memory backed by one or more SharedArrayBuffers (chunks).
 *
 * A single SharedArrayBuffer can be at most 4 GiB, so a buffer that needs to
 * grow beyond that is split into multiple chunks. Each chunk is its own
 * SharedArrayBuffer (<= `chunkMax` bytes). Offsets are logical and continuous
 * across chunks; access methods resolve an offset into (chunk, chunkOffset).
 *
 * All chunks are pre-allocated at construction with `maxByteLength = chunkSize`
 * but only 4 bytes of actual storage. A chunk is "activated" (grown to its
 * full `chunkSize`) on first access. Because `SharedArrayBuffer.grow()` is
 * visible across all workers sharing the buffer, activation needs no
 * postMessage broadcast.
 */
interface Chunk {
  buffer: SharedArrayBuffer;
  view: DataView;
  /** Whether the chunk has been grown to its full size. */
  active: boolean;
}

/** Round `n` up to the next power of two (chunk sizes must be powers of two). */
function nextPowerOfTwo(n: number): number {
  if (n <= 0) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export class GrowableBuffer {
  private chunks: Chunk[] = [];
  private readonly maxByteLength: number;
  /** Fixed size of every chunk (the minimum growth step). */
  readonly chunkSize: number;
  /** log2(chunkSize), used for O(1) offset resolution via bit shifts. */
  private readonly chunkShift: number;
  private readonly budget?: SharedBudget;
  private used = 0;

  constructor(
    initialSizeOrBuffer: number | SharedArrayBuffer | SharedArrayBuffer[],
    maxByteLength: number,
    budget?: SharedBudget,
    chunkSize = 32 * 1024 * 1024, // 32 MiB per chunk
  ) {
    this.maxByteLength = maxByteLength;
    this.budget = budget;
    if (typeof initialSizeOrBuffer === "number") {
      this.chunkSize = Math.min(nextPowerOfTwo(chunkSize), maxByteLength);
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
        this.budget?.add(sab.byteLength);
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
      this.budget?.add(initialSizeOrBuffer.byteLength);
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
    chunk.buffer.grow(this.chunkSize);
    chunk.view = new DataView(chunk.buffer);
    chunk.active = true;
    this.budget?.add(this.chunkSize);
  }

  /** Number of bytes written so far (used length, not buffer capacity). */
  get byteLength(): number {
    return this.used;
  }

  /** Total logical capacity across all chunks (active or not). */
  get capacity(): number {
    return this.chunks.length * this.chunkSize;
  }

  /** The list of SharedArrayBuffers backing this buffer (for export). */
  get buffers(): SharedArrayBuffer[] {
    return this.chunks.map((c) => c.buffer);
  }

  /** Number of chunks that have been activated (grown to full size). */
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
    this.chunks = newBuffers.map((sab) => ({
      buffer: sab,
      view: new DataView(sab),
      active: sab.byteLength === this.chunkSize,
    }));
  }

  /**
   * Resolve a logical offset into (chunk, offset within that chunk). All
   * chunks are the same size, so this is O(1). Activates the chunk if it is
   * not yet active.
   */
  private resolve(offset: number): { chunk: Chunk; off: number } {
    const index = offset >> this.chunkShift;
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
    // All chunks are pre-allocated; just activate the ones needed to cover
    // `needed`. grow() is visible across workers, so no broadcast is required.
    const neededChunks = Math.ceil(needed / this.chunkSize);
    for (let i = 0; i < neededChunks; i++) {
      this.activate(i);
    }
  }

  /** Mark `n` bytes as used, after writing them at the current offset. */
  advance(n: number): void {
    this.used += n;
  }

  /**
   * Reset the used length to `n` bytes. Used by defragmentation after
   * compacting live data to the front of the buffer. Chunks beyond the
   * compacted region are marked inactive; their storage is reclaimed by
   * `releaseInactiveChunks()`.
   */
  reset(n: number): void {
    this.used = n;
    const neededChunks = Math.ceil(n / this.chunkSize);
    for (let i = neededChunks; i < this.chunks.length; i++) {
      this.chunks[i]!.active = false;
    }
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
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      if (chunk.active) continue;
      // Release the old full-size buffer from the budget and replace it with
      // a fresh 4-byte chunk.
      this.budget?.release(this.chunkSize);
      const buffer = new SharedArrayBuffer(4, {
        maxByteLength: this.chunkSize,
      });
      this.chunks[i] = { buffer, view: new DataView(buffer), active: false };
    }
    return this.chunks.map((c) => c.buffer);
  }

  // -------------------------------------------------------------------------
  // Typed accessors (resolve offset -> chunk)
  // -------------------------------------------------------------------------

  getInt32(offset: number): number {
    const index = offset >> this.chunkShift;
    this.activate(index);
    return this.chunks[index]!.view.getInt32(
      offset & (this.chunkSize - 1),
      true,
    );
  }

  setInt32(offset: number, value: number): void {
    const index = offset >> this.chunkShift;
    this.activate(index);
    this.chunks[index]!.view.setInt32(
      offset & (this.chunkSize - 1),
      value,
      true,
    );
  }

  getUint8(offset: number): number {
    const index = offset >> this.chunkShift;
    this.activate(index);
    return this.chunks[index]!.view.getUint8(offset & (this.chunkSize - 1));
  }

  setUint8(offset: number, value: number): void {
    const index = offset >> this.chunkShift;
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
