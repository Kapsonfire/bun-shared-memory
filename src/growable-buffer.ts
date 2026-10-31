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
 * Growable SharedArrayBuffer helper.
 *
 * SharedArrayBuffer supports `grow(newLength)` when created with
 * `maxByteLength`. Growth preserves existing data, can only grow up to
 * `maxByteLength`, and cannot shrink. All workers sharing the buffer see the
 * growth immediately.
 */
export class GrowableBuffer {
  readonly buffer: SharedArrayBuffer;
  private view: DataView;
  private readonly maxByteLength: number;
  private readonly budget?: SharedBudget;
  private used = 0;

  constructor(
    initialSizeOrBuffer: number | SharedArrayBuffer,
    maxByteLength: number,
    budget?: SharedBudget,
  ) {
    this.buffer =
      typeof initialSizeOrBuffer === "number"
        ? new SharedArrayBuffer(initialSizeOrBuffer, { maxByteLength })
        : initialSizeOrBuffer;
    this.view = new DataView(this.buffer);
    this.maxByteLength = maxByteLength;
    this.budget = budget;
    this.budget?.add(this.buffer.byteLength);
  }

  /** Number of bytes written so far (used length, not buffer capacity). */
  get byteLength(): number {
    return this.used;
  }

  /** Ensure the buffer has room for at least `needed` bytes. */
  ensureCapacity(needed: number): void {
    if (needed <= this.buffer.byteLength) return;
    if (needed > this.maxByteLength) {
      throw new RangeError(
        `Shared buffer capacity exceeded: need ${needed} bytes but max is ${this.maxByteLength}`,
      );
    }
    let newSize = this.buffer.byteLength * 2;
    while (newSize < needed) newSize *= 2;
    if (newSize > this.maxByteLength) newSize = this.maxByteLength;
    if (this.budget && !this.budget.tryGrow(this.buffer.byteLength, newSize)) {
      throw new RangeError(
        `Shared memory budget exceeded: growing to ${newSize} bytes would exceed the total budget`,
      );
    }
    this.buffer.grow(newSize);
    this.view = new DataView(this.buffer);
  }

  /** Mark `n` bytes as used, after writing them at the current offset. */
  advance(n: number): void {
    this.used += n;
  }

  /**
   * Reset the used length to `n` bytes. Used by defragmentation after
   * compacting live data to the front of the buffer. The underlying
   * SharedArrayBuffer is not shrunk (it cannot be), but the tail beyond `n`
   * is treated as free space for future writes.
   */
  reset(n: number): void {
    this.used = n;
  }

  getView(): DataView {
    return this.view;
  }
}
