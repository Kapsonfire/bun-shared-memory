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
}

/**
 * Growable shared memory backed by one or more SharedArrayBuffers (chunks).
 *
 * A single SharedArrayBuffer can be at most 4 GiB, so a buffer that needs to
 * grow beyond that is split into multiple chunks. Each chunk is its own
 * SharedArrayBuffer (<= `chunkMax` bytes). Offsets are logical and continuous
 * across chunks; access methods resolve an offset into (chunk, chunkOffset).
 *
 * All workers sharing the buffer see growth immediately (each chunk is a
 * SharedArrayBuffer shared via postMessage).
 */
interface Chunk {
  buffer: SharedArrayBuffer;
  view: DataView;
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
  private readonly chunkSize: number;
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
      this.addChunk();
    } else if (Array.isArray(initialSizeOrBuffer)) {
      // Reconstruct from a list of chunks. Use the buffers directly (they are
      // already shared via postMessage) so writes are visible across workers.
      // All chunks must be the same size to keep resolve() O(1); the first
      // chunk's size defines the chunk size.
      this.chunkSize = initialSizeOrBuffer[0]?.byteLength ?? chunkSize;
      this.chunkShift = Math.log2(this.chunkSize);
      for (const sab of initialSizeOrBuffer) {
        this.chunks.push({ buffer: sab, view: new DataView(sab) });
        this.budget?.add(sab.byteLength);
      }
    } else {
      // Reconstruct from a single existing buffer. Use it directly so writes
      // are shared. Its size defines the chunk size.
      this.chunkSize = initialSizeOrBuffer.byteLength;
      this.chunkShift = Math.log2(this.chunkSize);
      this.chunks.push({
        buffer: initialSizeOrBuffer,
        view: new DataView(initialSizeOrBuffer),
      });
      this.budget?.add(initialSizeOrBuffer.byteLength);
    }
  }

  private addChunk(): void {
    const buffer = new SharedArrayBuffer(this.chunkSize, {
      maxByteLength: this.chunkSize,
    });
    this.chunks.push({ buffer, view: new DataView(buffer) });
    this.budget?.add(this.chunkSize);
  }

  /** Number of bytes written so far (used length, not buffer capacity). */
  get byteLength(): number {
    return this.used;
  }

  /** Total physical capacity across all chunks. */
  get capacity(): number {
    return this.chunks.length * this.chunkSize;
  }

  /** The list of SharedArrayBuffers backing this buffer (for export). */
  get buffers(): SharedArrayBuffer[] {
    return this.chunks.map((c) => c.buffer);
  }

  /**
   * Resolve a logical offset into (chunk, offset within that chunk). All
   * chunks are the same size, so this is O(1).
   */
  private resolve(offset: number): { chunk: Chunk; off: number } {
    const index = offset >> this.chunkShift;
    const chunk = this.chunks[index];
    if (chunk === undefined) {
      throw new RangeError(`Offset ${offset} is beyond the buffer capacity`);
    }
    return { chunk, off: offset & (this.chunkSize - 1) };
  }

  /** Ensure the buffer has room for at least `needed` bytes. */
  ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    if (needed > this.maxByteLength) {
      throw new RangeError(
        `Shared buffer capacity exceeded: need ${needed} bytes but max is ${this.maxByteLength}`,
      );
    }
    // Append full chunks until the capacity covers `needed`. Each addChunk
    // charges the budget (and throws if the total budget would be exceeded).
    while (this.capacity < needed) {
      this.addChunk();
    }
  }

  /** Mark `n` bytes as used, after writing them at the current offset. */
  advance(n: number): void {
    this.used += n;
  }

  /**
   * Reset the used length to `n` bytes. Used by defragmentation after
   * compacting live data to the front of the buffer. The underlying
   * SharedArrayBuffers are not shrunk (they cannot be), but the tail beyond
   * `n` is treated as free space for future writes.
   */
  reset(n: number): void {
    this.used = n;
  }

  // -------------------------------------------------------------------------
  // Typed accessors (resolve offset -> chunk)
  // -------------------------------------------------------------------------

  getInt32(offset: number): number {
    const index = offset >> this.chunkShift;
    return this.chunks[index]!.view.getInt32(
      offset & (this.chunkSize - 1),
      true,
    );
  }

  setInt32(offset: number, value: number): void {
    const index = offset >> this.chunkShift;
    this.chunks[index]!.view.setInt32(
      offset & (this.chunkSize - 1),
      value,
      true,
    );
  }

  getUint8(offset: number): number {
    const index = offset >> this.chunkShift;
    return this.chunks[index]!.view.getUint8(offset & (this.chunkSize - 1));
  }

  setUint8(offset: number, value: number): void {
    const index = offset >> this.chunkShift;
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
