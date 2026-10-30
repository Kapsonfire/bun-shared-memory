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

  constructor(initialSize: number, maxByteLength: number) {
    this.buffer = new SharedArrayBuffer(initialSize, { maxByteLength });
    this.view = new DataView(this.buffer);
    this.maxByteLength = maxByteLength;
  }

  get byteLength(): number {
    return this.buffer.byteLength;
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

  getView(): DataView {
    return this.view;
  }
}
