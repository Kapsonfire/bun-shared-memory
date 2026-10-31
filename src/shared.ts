import {
  SharedMemory,
  TYPE_ARRAY_REF,
  arrayRefSlot,
  bigintSlot,
  booleanSlot,
  decodeSlot,
  numberSlot,
  stringRefSlot,
  type ArrayRef,
  type ObjectLayout,
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
export type SharedRef<T> = [T] extends [object]
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

/**
 * Per-worker read cache: key -> { version, value, index }.
 *
 * Each worker has its own cache (module-level, not shared). A read hits the
 * cache when the key's version cell (in shared memory) matches the cached
 * version. Writes bump the version cell, so any worker's cache is invalidated
 * automatically on the next read. The key's stable index is cached too, so a
 * cache hit avoids the linear index-table lookup.
 */
const readCache = new Map<string, { version: number; value: unknown; index: number }>();

/**
 * Per-worker cache of decoded object properties: key -> { version, props }.
 *
 * When a property of an object is read via the layout (single-slot decode),
 * the decoded value is cached here keyed by the object's version. A hit avoids
 * re-decoding the property (e.g. re-reading a string from the StringTable) on
 * repeated reads of the same property. Writes bump the object's version, so
 * the whole entry is invalidated automatically.
 */
const propCache = new Map<string, { version: number; index: number; props: Map<string, unknown> }>();

/**
 * Per-worker cache of object layouts: key -> stable property slot offsets.
 *
 * Because object properties may not be added or removed, the layout is static
 * for the lifetime of the object. It is built once (under the lock) and cached
 * so individual property reads can decode only the requested slot instead of
 * the whole object. If a future GC/defragmentation moves an object block, this
 * cache must be invalidated (e.g. via a layout version cell).
 */
const layoutCache = new Map<string, ObjectLayout | null>();

/** Get (and cache) the stable layout of an object value, or null if not an object. */
function getObjectLayout(mem: SharedMemory, key: string): ObjectLayout | null {
  if (layoutCache.has(key)) return layoutCache.get(key)!;
  const layout = mem.withLock(() => mem.getObjectLayout(key));
  layoutCache.set(key, layout);
  return layout;
}

/** Deep-ish copy of a decoded value, so callers can't corrupt the cache. */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = Array.isArray(v) ? [...v] : v;
    }
    return copy;
  }
  return value;
}

/** Options for creating a shared value. */
export interface SharedOptions {
  /** Initial size of each shared buffer in bytes. */
  initialSize?: number;
  /** Maximum size of each shared buffer in bytes. */
  maxByteLength?: number;
  /**
   * An existing SharedMemory instance to use. When provided, the value is
   * stored in (and read from) this shared memory, allowing multiple workers
   * to access the same buffers.
   */
  memory?: SharedMemory;
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

  const mem = options.memory ?? new SharedMemory(options);
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
    read: () => copyValue(readValue(mem, key)) as T,
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

      // Fast path: if the full value is cached and valid, read the property
      // from the cached value (no decode, no lock).
      const cachedValue = getCachedValue(mem, key);
      if (cachedValue !== undefined) {
        if (Array.isArray(cachedValue)) {
          return getTopLevelArrayMember(mem, key, cachedValue, prop);
        }
        const propValue = (cachedValue as Record<string | symbol, unknown>)[prop];
        if (Array.isArray(propValue)) {
          return createArrayProxy(mem, key, prop as string);
        }
        return propValue;
      }

      // Cache miss: for objects, decode only the requested property's slot via
      // the cached layout, avoiding a full-object decode. The decoded value is
      // cached per property so repeated reads of the same property are cheap.
      const layout = getObjectLayout(mem, key);
      if (layout !== null) {
        const slotOffset = layout.properties.get(prop as string);
        if (slotOffset === undefined) return undefined;

        // Property cache hit: the object's version is unchanged.
        const pc = propCache.get(key);
        const version = pc !== undefined ? mem.getVersion(pc.index) : -1;
        if (pc !== undefined && pc.version === version) {
          const cachedProp = pc.props.get(prop as string);
          if (cachedProp !== undefined) {
            if (Array.isArray(cachedProp)) {
              return createArrayProxy(mem, key, prop as string);
            }
            return cachedProp;
          }
        }

        // Decode the single slot and cache it under the object's version.
        // The key's index is stable (keys are never removed), so reuse the
        // cached index when available to avoid the linear index-table lookup.
        const index =
          pc !== undefined
            ? pc.index
            : readCache.get(key)?.index ?? mem.lookupIndex(key) ?? 0;
        const slot = mem.readValueSlot(slotOffset);
        const propValue = decodeValue(mem, slot);
        if (pc === undefined || pc.version !== version) {
          propCache.set(key, { version: mem.getVersion(index), index, props: new Map() });
        }
        propCache.get(key)!.props.set(prop as string, propValue);
        if (Array.isArray(propValue)) {
          return createArrayProxy(mem, key, prop as string);
        }
        return propValue;
      }

      // Primitive/array key: use the cached value directly (no copy).
      const value = readValue(mem, key);
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
      // In-place update: write only the affected slot instead of decoding and
      // re-encoding the whole value.
      return mem.withLock(() => {
        // Object property: use the cached layout to write only that slot.
        const layout = getObjectLayout(mem, key);
        if (layout !== null) {
          const slotOffset = layout.properties.get(prop as string);
          if (slotOffset === undefined) {
            throw new TypeError(
              `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
            );
          }
          mem.updateValueSlot(slotOffset, encodeValue(mem, val));
          bump(mem, key);
          return true;
        }

        // Top-level array index write: update only that array slot.
        const offset = mem.lookup(key);
        if (offset === null) {
          throw new Error(`No shared value found for key "${key}"`);
        }
        const slot = mem.readValueSlot(offset);
        if (slot.type === TYPE_ARRAY_REF && typeof prop === "string" && /^\d+$/.test(prop)) {
          const index = Number(prop);
          const ref = { offset: slot.a, count: slot.b };
          if (index >= ref.count) {
            throw new RangeError(`Index ${index} out of bounds for array of length ${ref.count}`);
          }
          mem.updateArraySlot(ref, index, encodeValue(mem, val));
          bump(mem, key);
          return true;
        }

        // Fallback: full read-modify-write (e.g. setting a primitive key's
        // property, or a non-index property on an array).
        return mutateValue<T, boolean>(mem, key, (value) => {
          if (Array.isArray(value)) {
            (value as unknown as Record<string | symbol, unknown>)[prop] = val;
          } else {
            (value as Record<string | symbol, unknown>)[prop] = val;
          }
          return true;
        });
      });
    },
    deleteProperty() {
      throw new TypeError(
        "Shared values have a fixed shape: properties may not be added or removed",
      );
    },
  }) as unknown as SharedRef<T>;
}

/**
 * Return the cached full value for a key if it is still valid (lock-free
 * version check), or undefined on a cache miss. Does not decode.
 */
function getCachedValue(mem: SharedMemory, key: string): unknown | undefined {
  const cached = readCache.get(key);
  if (cached === undefined) return undefined;
  if (cached.version !== mem.getVersion(cached.index)) return undefined;
  return cached.value;
}

/** Read the full value for a key from shared memory, using the read cache. */
function readValue(mem: SharedMemory, key: string): unknown {
  const cached = readCache.get(key);
  const index =
    cached !== undefined
      ? cached.index
      : (() => {
          const i = mem.lookupIndex(key);
          if (i === null) {
            throw new Error(`No shared value found for key "${key}"`);
          }
          return i;
        })();

  // Lock-free fast path: if the cached version matches the current version
  // cell, the cached value is still valid.
  const version = mem.getVersion(index);
  if (cached !== undefined && cached.version === version) {
    return cached.value;
  }

  // Cache miss: decode under the lock and cache with the observed version.
  const value = mem.withLock(() => {
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
  });

  readCache.set(key, { version, value, index });
  return value;
}

/** Write a full value for a key to shared memory. */
function writeValue(mem: SharedMemory, key: string, value: unknown): void {
  mem.withLock(() => {
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
        bump(mem, key);
        return;
      }
      // Update a single value slot in place.
      mem.updateValueSlot(existing, encodeValue(mem, value));
      bump(mem, key);
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
  });
}

/** Bump the version cell for a key, invalidating read caches. */
function bump(mem: SharedMemory, key: string): void {
  const index = mem.lookupIndex(key);
  if (index !== null) mem.bumpVersion(index);
}

/** Atomically update the value for a key. */
function updateValue<T>(
  mem: SharedMemory,
  key: string,
  fn: (current: T) => T,
): T {
  return mem.withLock(() => {
    const current = readValue(mem, key) as T;
    const next = fn(current);
    writeValue(mem, key, next);
    return next;
  });
}

/**
 * Atomically read-modify-write a value under a single lock acquisition.
 * Unlike `updateValue`, the transform may return a different value than the
 * one written (e.g. array methods return the popped element).
 */
function mutateValue<T, R>(
  mem: SharedMemory,
  key: string,
  fn: (current: T) => R,
): R {
  return mem.withLock(() => {
    const current = readValue(mem, key) as T;
    const result = fn(current);
    writeValue(mem, key, current);
    return result;
  });
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
      return mutateValue<unknown[], unknown>(mem, key, (fresh) => {
        const method = (fresh as unknown as Record<string, (...a: unknown[]) => unknown>)[methodName]!;
        return method.apply(fresh, args);
      });
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
          return mutateValue<Record<string, unknown>, unknown>(
            mem,
            key,
            (fresh) => {
              const freshArr = fresh[prop] as unknown[];
              const method = (freshArr as unknown as Record<string, (...a: unknown[]) => unknown>)[methodName]!;
              return method.apply(freshArr, args);
            },
          );
        };
      }
      const method = (arr as unknown as Record<string, unknown>)[arrProp];
      if (typeof method === "function") return method.bind(arr);
      return method;
    },
    set(_target, arrProp, val) {
      // In-place update: write only the affected array slot instead of
      // decoding and re-encoding the whole object.
      return mem.withLock(() => {
        const layout = getObjectLayout(mem, key);
        if (layout !== null) {
          const slotOffset = layout.properties.get(prop);
          if (slotOffset !== undefined) {
            const propSlot = mem.readValueSlot(slotOffset);
            if (propSlot.type === TYPE_ARRAY_REF && typeof arrProp === "string" && /^\d+$/.test(arrProp)) {
              const index = Number(arrProp);
              const ref = { offset: propSlot.a, count: propSlot.b };
              if (index >= ref.count) {
                throw new RangeError(`Index ${index} out of bounds for array of length ${ref.count}`);
              }
              mem.updateArraySlot(ref, index, encodeValue(mem, val));
              bump(mem, key);
              return true;
            }
          }
        }
        // Fallback: full read-modify-write.
        return mutateValue<Record<string, unknown>, boolean>(
          mem,
          key,
          (fresh) => {
            const arr = fresh[prop] as unknown[];
            (arr as unknown as Record<string | symbol, unknown>)[arrProp] = val;
            return true;
          },
        );
      });
    },
  });
}
