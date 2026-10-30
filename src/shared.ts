import { deserialize, encodedSize, serialize } from "./serialization.ts";

/**
 * Header layout of a shared value slot (in bytes):
 *   [0..3]   lock (Int32) — 0 = unlocked, 1 = locked
 *   [4..7]   data length (Int32) — number of valid data bytes
 *   [8..]    serialized data
 */
const HEADER_LOCK = 0;
const HEADER_LENGTH = 4;
const HEADER_SIZE = 8;

/** Maximum size of a single shared value slot. */
const DEFAULT_SLOT_SIZE = 64 * 1024; // 64 KiB

/** Extract the fixed set of keys of an object, or null if not an object. */
function objectKeys(value: unknown): string[] | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).sort();
  }
  return null;
}

/**
 * A reference to a value stored in shared memory.
 *
 * All reads and writes are synchronized with an Atomics-based lock so that
 * multiple workers can safely access the same value.
 *
 * If the value is an object, its shape (set of properties) is fixed at
 * creation time: properties may not be added or removed afterwards.
 */
export class SharedRef<T> {
  readonly key: string;
  readonly buffer: SharedArrayBuffer;
  private readonly lockView: Int32Array;
  private readonly lengthView: Int32Array;
  private readonly dataView: Uint8Array;
  private shape: string[] | null = null;

  constructor(key: string, buffer: SharedArrayBuffer) {
    this.key = key;
    this.buffer = buffer;
    this.lockView = new Int32Array(buffer, HEADER_LOCK, 1);
    this.lengthView = new Int32Array(buffer, HEADER_LENGTH, 1);
    this.dataView = new Uint8Array(buffer, HEADER_SIZE);
  }

  /** Acquire the lock, blocking until it is available. */
  private lock(): void {
    while (Atomics.compareExchange(this.lockView, 0, 0, 1) !== 0) {
      Atomics.wait(this.lockView, 0, 1);
    }
  }

  /** Release the lock and wake any waiters. */
  private unlock(): void {
    Atomics.store(this.lockView, 0, 0);
    Atomics.notify(this.lockView, 0, 1);
  }

  /** Validate that a value conforms to the fixed object shape, if any. */
  private validateShape(value: T): void {
    const keys = objectKeys(value);
    if (this.shape === null) {
      // First write: capture the shape.
      this.shape = keys;
      return;
    }
    if (keys === null) {
      // The value is no longer an object but the shape was fixed as an object.
      throw new TypeError(
        `Value for key "${this.key}" was created as an object and must remain an object`,
      );
    }
    if (keys.length !== this.shape.length) {
      throw new TypeError(
        `Value for key "${this.key}" has a fixed shape: properties may not be added or removed`,
      );
    }
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== this.shape[i]) {
        throw new TypeError(
          `Value for key "${this.key}" has a fixed shape: properties may not be added or removed`,
        );
      }
    }
  }

  /** Read the current value from shared memory. */
  read(): T {
    this.lock();
    try {
      const length = Atomics.load(this.lengthView, 0);
      const bytes = this.dataView.subarray(0, length);
      return deserialize(bytes) as T;
    } finally {
      this.unlock();
    }
  }

  /** Write a new value to shared memory. */
  write(value: T): void {
    this.validateShape(value);
    const bytes = serialize(value);
    if (bytes.byteLength > this.dataView.byteLength) {
      throw new RangeError(
        `Value for key "${this.key}" is too large: ${bytes.byteLength} bytes exceeds slot capacity of ${this.dataView.byteLength} bytes`,
      );
    }
    this.lock();
    try {
      this.dataView.set(bytes);
      Atomics.store(this.lengthView, 0, bytes.byteLength);
    } finally {
      this.unlock();
    }
  }

  /** Atomically update the value using a transform function. */
  update(fn: (current: T) => T): T {
    this.lock();
    try {
      const length = Atomics.load(this.lengthView, 0);
      const current = deserialize(this.dataView.subarray(0, length)) as T;
      const next = fn(current);
      this.validateShape(next);
      const bytes = serialize(next);
      if (bytes.byteLength > this.dataView.byteLength) {
        throw new RangeError(
          `Updated value for key "${this.key}" is too large: ${bytes.byteLength} bytes exceeds slot capacity of ${this.dataView.byteLength} bytes`,
        );
      }
      this.dataView.set(bytes);
      Atomics.store(this.lengthView, 0, bytes.byteLength);
      return next;
    } finally {
      this.unlock();
    }
  }
}

/** Options for creating a shared value. */
export interface SharedOptions {
  /** Size in bytes of the shared slot. Defaults to 64 KiB. */
  size?: number;
}

type Loader<T> = () => T | Promise<T>;

const registry = new Map<string, SharedRef<unknown>>();

/**
 * Get a wrapper to a named value in shared memory.
 *
 * If the value does not exist yet, it is created using the provided initial
 * value or loader function (which may be async). If it already exists, the
 * existing wrapper is returned and the initial value/loader is ignored.
 *
 * Returns a Promise when a loader is provided (since it may be async), and a
 * SharedRef directly when an initial value is provided.
 */
export function Shared<T>(
  key: string,
  loader: Loader<T>,
  options?: SharedOptions,
): Promise<SharedRef<T>>;
export function Shared<T>(
  key: string,
  initial: T,
  options?: SharedOptions,
): SharedRef<T>;
export function Shared<T>(
  key: string,
  initialOrLoader: T | Loader<T>,
  options: SharedOptions = {},
): SharedRef<T> | Promise<SharedRef<T>> {
  const existing = registry.get(key);
  if (existing) return existing as SharedRef<T>;

  const size = options.size ?? DEFAULT_SLOT_SIZE;
  const buffer = new SharedArrayBuffer(HEADER_SIZE + size);
  const ref = new SharedRef<T>(key, buffer);
  registry.set(key, ref as SharedRef<unknown>);

  if (typeof initialOrLoader === "function") {
    return Promise.resolve((initialOrLoader as Loader<T>)()).then((value) => {
      ref.write(value);
      return ref;
    });
  }

  ref.write(initialOrLoader as T);
  return ref;
}
