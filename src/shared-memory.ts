/**
 * A low-level wrapper around a `SharedArrayBuffer` that provides
 * typed access to shared memory.
 *
 * This is the foundation of the library. It manages a fixed-size
 * shared buffer and exposes typed views over it.
 */
export class SharedMemory {
  readonly buffer: SharedArrayBuffer;
  readonly byteLength: number;

  constructor(byteLength: number) {
    if (!Number.isInteger(byteLength) || byteLength <= 0) {
      throw new RangeError("byteLength must be a positive integer");
    }
    this.byteLength = byteLength;
    this.buffer = new SharedArrayBuffer(byteLength);
  }

  /**
   * Create a typed array view over the entire shared buffer.
   */
  view<T extends ArrayBufferView>(
    ctor: new (buffer: SharedArrayBuffer) => T,
  ): T {
    return new ctor(this.buffer);
  }

  /**
   * Create a typed array view over a slice of the shared buffer.
   */
  viewSlice<T extends ArrayBufferView>(
    ctor: new (buffer: SharedArrayBuffer, byteOffset: number, length?: number) => T,
    byteOffset: number,
    length?: number,
  ): T {
    if (byteOffset < 0 || byteOffset >= this.byteLength) {
      throw new RangeError("byteOffset out of bounds");
    }
    return new ctor(this.buffer, byteOffset, length);
  }

  /**
   * The underlying SharedArrayBuffer, for passing to workers.
   */
  get raw(): SharedArrayBuffer {
    return this.buffer;
  }
}
