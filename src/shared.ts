import {
  SharedMemory,
  arrayRefSlot,
  bigintSlot,
  booleanSlot,
  decodeSlot,
  numberSlot,
  stringRefSlot,
  type ArrayRef,
  type StringRef,
  type ValueSlot,
} from "./memory.ts";

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

type Primitive = number | string | boolean | bigint;

/** Convert a JS value into a ValueSlot, storing strings/arrays in tables. */
function encodeValue(mem: SharedMemory, value: unknown): ValueSlot {
  switch (typeof value) {
    case "number":
      return numberSlot(value);
    case "boolean":
      return booleanSlot(value);
    case "bigint":
      return bigintSlot(value);
    case "string":
      return stringRefSlot(mem.storeString(value));
    default:
      if (Array.isArray(value)) {
        for (const v of value) {
          if (Array.isArray(v) || (v !== null && typeof v === "object")) {
            throw new TypeError(
              "Arrays may only contain primitives and bigints (no nested arrays or objects)",
            );
          }
        }
        const slots = value.map((v) => encodeValue(mem, v));
        return arrayRefSlot(mem.storeArray(slots));
      }
      throw new TypeError(
        `Cannot store value of type ${typeof value}: only primitives, bigints, and arrays of these are allowed`,
      );
  }
}

/** Decode a ValueSlot into a JS value, reading strings/arrays from tables. */
function decodeValue(mem: SharedMemory, slot: ValueSlot): unknown {
  switch (slot.type) {
    case 3: // string-ref
      return mem.readString({ offset: slot.a, length: slot.b });
    case 4: // array-ref
      return mem.readArray({ offset: slot.a, count: slot.b }).map((s) =>
        decodeValue(mem, s),
      );
    default:
      return decodeSlot(slot);
  }
}

/**
 * A reference to a value stored in shared memory.
 *
 * Exposes direct property access to the shared value. For objects, properties
 * are accessed directly (e.g. `user.name`). For arrays, index access and
 * mutating methods (push, pop, splice, ...) work directly. All access is
 * synchronized with an Atomics-based lock.
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
  /** Initial size of each shared buffer in bytes. */
  initialSize?: number;
  /** Maximum size of each shared buffer in bytes. */
  maxByteLength?: number;
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

  const mem = new SharedMemory(options);
  const ref = createSharedRef<T>(mem, key);
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

/** Create a SharedRef proxy backed by a SharedMemory instance. */
function createSharedRef<T>(mem: SharedMemory, key: string): SharedRef<T> {
  const target = {
    key,
    mem,
    read: () => readValue(mem, key),
    write: (value: T) => writeValue(mem, key, value),
    update: (fn: (current: T) => T) => updateValue(mem, key, fn),
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop === "read") return t.read;
      if (prop === "write") return t.write;
      if (prop === "update") return t.update;
      if (prop === "key") return t.key;
      if (prop === "buffer") return mem.dataTable.buffer;
      if (prop === Symbol.toPrimitive) return () => t.read();

      const value = t.read();
      if (Array.isArray(value)) {
        return getTopLevelArrayMember(mem, key, value, prop);
      }
      // Object value: property access.
      const propValue = (value as Record<string | symbol, unknown>)[prop];
      if (Array.isArray(propValue)) {
        return createArrayProxy(mem, key, prop as string);
      }
      return propValue;
    },
    set(t, prop, val) {
      const value = t.read();
      if (Array.isArray(value)) {
        (value as unknown as Record<string | symbol, unknown>)[prop] = val;
        t.write(value as T);
        return true;
      }
      (value as Record<string | symbol, unknown>)[prop] = val;
      t.write(value as T);
      return true;
    },
    deleteProperty() {
      throw new TypeError(
        "Shared values have a fixed shape: properties may not be added or removed",
      );
    },
  }) as unknown as SharedRef<T>;
}

/** Read the full value for a key from shared memory. */
function readValue(mem: SharedMemory, key: string): unknown {
  const offset = mem.lookup(key);
  if (offset === null) {
    throw new Error(`No shared value found for key "${key}"`);
  }
  const type = mem.dataTable.getView().getInt32(offset, true);
  if (type === 5) {
    // Object block.
    const properties = mem.readObject(offset);
    const obj: Record<string, unknown> = {};
    for (const [name, slot] of properties) {
      obj[name] = decodeValue(mem, slot);
    }
    return obj;
  }
  // Single value slot (primitive or array).
  return decodeValue(mem, mem.readValueSlot(offset));
}

/** Write a full value for a key to shared memory. */
function writeValue(mem: SharedMemory, key: string, value: unknown): void {
  const existing = mem.lookup(key);
  if (existing !== null) {
    const type = mem.dataTable.getView().getInt32(existing, true);
    if (type === 5) {
      // Update existing object's property slots in place.
      const properties = mem.readObject(existing);
      const valueObj = value as Record<string, unknown>;
      for (let i = 0; i < properties.length; i++) {
        const [name] = properties[i]!;
        if (!(name in valueObj)) {
          throw new TypeError(
            `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
          );
        }
        mem.updateObjectSlot(existing, i, encodeValue(mem, valueObj[name]));
      }
      // Check for extra properties.
      const existingNames = new Set(properties.map(([n]) => n));
      for (const name of Object.keys(valueObj)) {
        if (!existingNames.has(name)) {
          throw new TypeError(
            `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
          );
        }
      }
      return;
    }
    // Update a single value slot in place.
    mem.updateValueSlot(existing, encodeValue(mem, value));
    return;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // Create a new object.
    const valueObj = value as Record<string, unknown>;
    const props: Array<[string, ValueSlot]> = Object.entries(valueObj).map(
      ([name, v]) => [name, encodeValue(mem, v)],
    );
    const offset = mem.createObject(props);
    mem.insert(key, offset);
    return;
  }

  // Create a single value slot (primitive or array).
  const offset = mem.storeValueSlot(encodeValue(mem, value));
  mem.insert(key, offset);
}

/** Atomically update the value for a key. */
function updateValue<T>(
  mem: SharedMemory,
  key: string,
  fn: (current: T) => T,
): T {
  const current = readValue(mem, key) as T;
  const next = fn(current);
  writeValue(mem, key, next);
  return next;
}

/** Get a member of a top-level array value, with read-modify-write for mutating methods. */
function getTopLevelArrayMember(
  mem: SharedMemory,
  key: string,
  value: unknown[],
  prop: string | symbol,
): unknown {
  if (prop === "length") return value.length;
  if (typeof prop === "string" && /^\d+$/.test(prop)) {
    return value[Number(prop)];
  }
  if (typeof prop === "symbol") {
    if (prop === Symbol.iterator) return value[Symbol.iterator].bind(value);
    return (value as unknown as Record<symbol, unknown>)[prop];
  }
  if (MUTATING_METHODS.has(prop)) {
    const methodName = prop;
    return (...args: unknown[]) => {
      const fresh = readValue(mem, key) as unknown[];
      const method = (fresh as unknown as Record<string, (...a: unknown[]) => unknown>)[methodName]!;
      const result = method.apply(fresh, args);
      writeValue(mem, key, fresh);
      return result;
    };
  }
  const method = (value as unknown as Record<string, unknown>)[prop];
  if (typeof method === "function") return method.bind(value);
  return method;
}

/** Create a proxy for an array property of a shared object. */
function createArrayProxy(
  mem: SharedMemory,
  key: string,
  prop: string,
): unknown[] {
  return new Proxy([] as unknown[], {
    get(_target, arrProp) {
      const current = readValue(mem, key) as Record<string, unknown>;
      const arr = current[prop] as unknown[];
      if (!Array.isArray(arr)) {
        throw new TypeError(`Property "${prop}" is not an array`);
      }
      if (arrProp === "length") return arr.length;
      if (typeof arrProp === "string" && /^\d+$/.test(arrProp)) {
        return arr[Number(arrProp)];
      }
      if (typeof arrProp === "symbol") {
        if (arrProp === Symbol.iterator) return arr[Symbol.iterator].bind(arr);
        return (arr as unknown as Record<symbol, unknown>)[arrProp];
      }
      if (MUTATING_METHODS.has(arrProp)) {
        const methodName = arrProp;
        return (...args: unknown[]) => {
          const fresh = readValue(mem, key) as Record<string, unknown>;
          const freshArr = fresh[prop] as unknown[];
          const method = (freshArr as unknown as Record<string, (...a: unknown[]) => unknown>)[methodName]!;
          const result = method.apply(freshArr, args);
          writeValue(mem, key, fresh);
          return result;
        };
      }
      const method = (arr as unknown as Record<string, unknown>)[arrProp];
      if (typeof method === "function") return method.bind(arr);
      return method;
    },
    set(_target, arrProp, val) {
      const current = readValue(mem, key) as Record<string, unknown>;
      const arr = current[prop] as unknown[];
      (arr as unknown as Record<string | symbol, unknown>)[arrProp] = val;
      writeValue(mem, key, current);
      return true;
    },
  });
}
