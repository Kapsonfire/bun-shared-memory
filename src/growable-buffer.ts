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
  private used = 0;

  constructor(
    initialSizeOrBuffer: number | SharedArrayBuffer,
    maxByteLength: number,
  ) {
    this.buffer =
      typeof initialSizeOrBuffer === "number"
        ? new SharedArrayBuffer(initialSizeOrBuffer, { maxByteLength })
        : initialSizeOrBuffer;
    this.view = new DataView(this.buffer);
    this.maxByteLength = maxByteLength;
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
