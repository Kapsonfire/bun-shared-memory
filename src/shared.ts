import { deserialize, serialize } from "./serialization.ts";

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

/** Array methods that mutate the array in place. */
const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/**
 * Internal implementation of a shared value. Holds the buffer and provides
 * synchronized read/write/update access. This is wrapped in a Proxy to expose
 * direct property access.
 */
class SharedRefImpl<T> {
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
      this.shape = keys;
      return;
    }
    if (keys === null) {
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

/** Create a proxy for an array property of a shared object. */
function createArrayProxy<T>(
  impl: SharedRefImpl<T>,
  prop: string | symbol,
): unknown[] {
  return new Proxy([] as unknown[], {
    get(_target, arrProp) {
      const current = (impl.read() as Record<string | symbol, unknown>)[prop];
      if (!Array.isArray(current)) {
        throw new TypeError(`Property "${String(prop)}" is not an array`);
      }
      if (arrProp === "length") return current.length;
      if (typeof arrProp === "string" && /^\d+$/.test(arrProp)) {
        return current[Number(arrProp)];
      }
      if (typeof arrProp === "symbol") {
        if (arrProp === Symbol.iterator) {
          return current[Symbol.iterator].bind(current);
        }
        return (current as unknown as Record<symbol, unknown>)[arrProp];
      }
      if (MUTATING_METHODS.has(arrProp)) {
        const methodName = arrProp as string;
        return (...args: unknown[]) => {
          let result: unknown;
          impl.update((value) => {
            const arr = (value as Record<string | symbol, unknown>)[prop] as unknown[];
            result = (arr as unknown as Record<string, (...a: unknown[]) => unknown>)[methodName]!(...args);
            (value as Record<string | symbol, unknown>)[prop] = arr;
            return value;
          });
          return result;
        };
      }
      const method = (current as unknown as Record<string, unknown>)[arrProp];
      if (typeof method === "function") {
        return method.bind(current);
      }
      return method;
    },
    set(_target, arrProp, val) {
      impl.update((value) => {
        const arr = (value as Record<string | symbol, unknown>)[prop] as unknown[];
        (arr as unknown as Record<string | symbol, unknown>)[arrProp] = val;
        (value as Record<string | symbol, unknown>)[prop] = arr;
        return value;
      });
      return true;
    },
  });
}

/** Create the proxy that exposes direct property access to a shared value. */
function createSharedRefProxy<T>(impl: SharedRefImpl<T>): SharedRef<T> {
  return new Proxy(impl, {
    get(target, prop, receiver) {      if (prop === "read") return target.read.bind(target);
      if (prop === "write") return target.write.bind(target);
      if (prop === "update") return target.update.bind(target);
      if (prop === "key") return target.key;
      if (prop === "buffer") return target.buffer;
      if (prop === Symbol.toPrimitive) return () => target.read();

      const value = target.read();
      if (Array.isArray(value)) {
        if (prop === "length") return value.length;
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return value[Number(prop)];
        }
        if (typeof prop === "symbol") {
          if (prop === Symbol.iterator) {
            return value[Symbol.iterator].bind(value);
          }
          return (value as unknown as Record<symbol, unknown>)[prop];
        }
        if (MUTATING_METHODS.has(prop)) {
          const methodName = prop as string;
          return (...args: unknown[]) => {
            let result: unknown;
            target.update((v) => {
              const arr = v as unknown[];
              result = (arr as unknown as Record<string, (...a: unknown[]) => unknown>)[methodName]!(...args);
              return arr as T;
            });
            return result;
          };
        }
        const method = (value as unknown as Record<string, unknown>)[prop];
        if (typeof method === "function") return method.bind(value);
        return method;
      }

      // Object value: property access.
      const propValue = (value as Record<string | symbol, unknown>)[prop];
      if (Array.isArray(propValue)) {
        return createArrayProxy(target, prop);
      }
      return propValue;
    },
    set(target, prop, val) {
      const value = target.read();
      if (Array.isArray(value)) {
        (value as unknown as Record<string | symbol, unknown>)[prop] = val;
        target.write(value);
        return true;
      }
      (value as Record<string | symbol, unknown>)[prop] = val;
      target.write(value);
      return true;
    },
    deleteProperty() {
      throw new TypeError(
        "Shared values have a fixed shape: properties may not be added or removed",
      );
    },
  }) as unknown as SharedRef<T>;
}

/**
 * A reference to a value stored in shared memory.
 *
 * Exposes direct property access to the shared value. For objects, properties
 * are accessed directly (e.g. `user.name`). For arrays, index access and
 * mutating methods (push, pop, splice, ...) work directly. All access is
 * synchronized with an Atomics-based lock.
 *
 * The full value can also be read/written via `read()`, `write()`, and
 * `update()`.
 */
export type SharedRef<T> = T extends object
  ? T & {
      read(): T;
      write(value: T): void;
      update(fn: (current: T) => T): T;
      readonly key: string;
      readonly buffer: SharedArrayBuffer;
    }
  : {
      read(): T;
      write(value: T): void;
      update(fn: (current: T) => T): T;
      readonly key: string;
      readonly buffer: SharedArrayBuffer;
    };

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
  const impl = new SharedRefImpl<T>(key, buffer);
  const ref = createSharedRefProxy(impl);
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
