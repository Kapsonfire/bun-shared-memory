import {
  SharedMemory,
  TYPE_ARRAY_REF,
  TYPE_BIGINT_STR,
  TYPE_INLINE_STRING,
  TYPE_STRING_REF,
  TYPE_STRING_VALUE_REF,
  arrayRefSlot,
  bigintSlot,
  bigintStrSlot,
  booleanSlot,
  decodeSlot,
  numberSlot,
  stringRefSlot,
  stringValueRefSlot,
  type ArrayRef,
  type ObjectLayout,
  type StringRef,
  type ValueSlot,
} from "./memory.ts";
import type { RefCountTracker } from "./refcount.ts";
import { getDefaultMemory, getDefaultTracker } from "./worker.ts";

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

/**
 * Run a write operation. Writes are lock-free by default: they increment the
 * in-flight write counter, and only fall back to the shared mutex if a
 * defragmentation pass is running (rare). This keeps the hot write path free
 * of the mutex's re-entrancy tracking while still preventing a write from
 * racing with a defragmentation pass.
 */
function writeLock<T>(mem: SharedMemory, fn: () => T): T {
  mem.beginWrite();
  if (mem.isDefragmenting()) {
    mem.endWrite();
    return mem.withLock(fn);
  }
  try {
    return fn();
  } finally {
    mem.endWrite();
  }
}

/** Inclusive bounds of a signed 64-bit integer (stored as a fast int64 slot). */
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

/** Convert a JS value into a ValueSlot, storing strings/arrays in tables. */
function encodeValue(
  mem: SharedMemory,
  value: unknown,
  arrayCapacity?: number,
  oldSlot?: ValueSlot,
): ValueSlot {
  switch (typeof value) {
    case "number":
      return numberSlot(value);
    case "boolean":
      return booleanSlot(value);
    case "bigint":
      // Bigints that fit in 64 bits are stored as a fast int64 slot; larger
      // ones are stored as their decimal string in the StringTable.
      if (value >= MIN_INT64 && value <= MAX_INT64) {
        return bigintSlot(value);
      }
      return bigintStrSlot(mem.storeString(value.toString()));
    case "string":
      // Reuse the existing string block in place when the new string fits.
      const oldRef =
        oldSlot?.type === TYPE_STRING_VALUE_REF
          ? { offset: oldSlot.a, length: oldSlot.b }
          : undefined;
      return stringValueRefSlot(mem.storeStringValue(value, oldRef));
    default:
      if (Array.isArray(value)) {
        for (const v of value) {
          if (Array.isArray(v) || (v !== null && typeof v === "object")) {
            throw new TypeError(
              "Arrays may only contain primitives and bigints (no nested arrays or objects)",
            );
          }
        }
        const slots = value.map((v) => encodeValue(mem, v, arrayCapacity));
        return arrayRefSlot(mem.storeArray(slots, arrayCapacity));
      }
      throw new TypeError(
        `Cannot store value of type ${typeof value}: only primitives, bigints, and arrays of these are allowed`,
      );
  }
}

/** Decode a ValueSlot into a JS value, reading strings/arrays from tables. */
function decodeValue(mem: SharedMemory, slot: ValueSlot): unknown {
  switch (slot.type) {
    case TYPE_STRING_REF: // property-name/string-table ref
      return mem.readString({ offset: slot.a, length: slot.b });
    case TYPE_STRING_VALUE_REF: // string value in the ArrayTable
      return mem.readStringValue({ offset: slot.a, length: slot.b });
    case TYPE_INLINE_STRING: // short string stored inline in the slot
      return mem.readInlineString(slot.a, slot.b, slot.c);
    case TYPE_BIGINT_STR: // bigint stored as decimal string
      return BigInt(mem.readString({ offset: slot.a, length: slot.b }));
    case 4: // array-ref
      return mem
        .readArray({ offset: slot.a, count: slot.b, capacity: slot.c })
        .map((s) => decodeValue(mem, s));
    default:
      return decodeSlot(slot);
  }
}

/**
 * Free the blocks referenced by a value slot (an array block or a string),
 * so they can be reused by the slab allocator. Called before a slot is
 * overwritten with a new value. No-op for primitive slots.
 *
 * No-op: string-value/array/object blocks are no longer freed on the hot
 * path (they are reclaimed by defragmentation instead).
 */
function freeSlotRefs(_mem: SharedMemory, _slot: ValueSlot): void {
  // Intentionally a no-op; dead blocks are reclaimed by defrag.
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
const readCache = new Map<
  string,
  { version: number; value: unknown; index: number }
>();

/**
 * Per-worker cache of a key's stable index in the Index Table.
 *
 * Keys are never removed, so a key's index is stable for its lifetime. Once
 * resolved, it can be cached forever, avoiding the linear index-table lookup
 * (which decodes every stored key string) on every access.
 */
const indexCache = new Map<string, number>();

/**
 * Per-worker cache of a key's current DataTable offset, valid only for the
 * layout version it was resolved under. The offset changes on
 * GC/defragmentation, so it is re-validated against the global layout version
 * on each access (a single Atomics.load). This avoids the Index-Table read on
 * every write, which is the dominant cost of the write hot path.
 */
const offsetCache = new Map<
  string,
  { offset: number; layoutVersion: number }
>();

/** Resolve a key's stable index, caching it after the first lookup. */
function getIndex(mem: SharedMemory, key: string): number {
  const cached = indexCache.get(key);
  if (cached !== undefined) return cached;
  const index = mem.lookupIndex(key);
  if (index === null) {
    throw new Error(`No shared value found for key "${key}"`);
  }
  indexCache.set(key, index);
  return index;
}

/**
 * Resolve a key's current DataTable offset using the cached stable index.
 * The offset can change on GC/defragmentation, so it is re-read from the
 * Index Table each time (a single Int32 read), but the expensive linear
 * key-string scan is avoided. Returns null if the key is not present.
 */
function getOffset(mem: SharedMemory, key: string): number | null {
  const cached = indexCache.get(key);
  if (cached !== undefined) {
    return mem.lookupByIndex(cached);
  }
  const index = mem.lookupIndex(key);
  if (index === null) return null;
  indexCache.set(key, index);
  return mem.lookupByIndex(index);
}

/**
 * The per-key cache fields on a SharedRef proxy target that the write hot
 * paths use to skip Map lookups and DataTable reads. `__offset`/`__type` are
 * valid only while `__layoutVersion` matches the global layout version;
 * `__arrayRef` additionally requires `__arrayRefLayoutVersion` to match (it is
 * bumped on defragmentation and on array growth via `moveArray`).
 */
interface WriteTarget {
  __offset?: number;
  __layoutVersion: number;
  __type?: number;
  __arrayRef?: { offset: number; count: number; capacity: number } | undefined;
  __arrayRefLayoutVersion: number;
  __index?: number | undefined;
}

/**
 * Resolve a key's current DataTable offset, caching it across writes. The
 * cached offset is only reused when the global layout version is unchanged
 * (i.e. no defragmentation has moved the data since it was cached); otherwise
 * it is re-resolved from the Index Table.
 */
function getCachedOffset(
  mem: SharedMemory,
  key: string,
  target?: WriteTarget,
): number | null {
  if (target !== undefined && target.__offset !== undefined) {
    if (target.__layoutVersion === mem.getLayoutVersion()) {
      return target.__offset;
    }
    target.__offset = undefined;
    target.__type = undefined;
    target.__arrayRef = undefined;
  }
  const cached = offsetCache.get(key);
  if (cached !== undefined) {
    if (cached.layoutVersion === mem.getLayoutVersion()) {
      if (target !== undefined) {
        target.__offset = cached.offset;
        target.__layoutVersion = cached.layoutVersion;
      }
      return cached.offset;
    }
    offsetCache.delete(key);
  }
  const offset = getOffset(mem, key);
  if (offset !== null) {
    offsetCache.set(key, { offset, layoutVersion: mem.getLayoutVersion() });
    if (target !== undefined) {
      target.__offset = offset;
      target.__layoutVersion = mem.getLayoutVersion();
      target.__type = undefined;
      target.__arrayRef = undefined;
    }
  }
  return offset;
}

/** Whether a decoded value is a reference-countable object/array. */
function isTrackable(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

/**
 * Get the stable objectId of a key's top-level value, or null if it is a
 * primitive (which is stored inline and not reference-counted).
 */
function getTopLevelObjectId(mem: SharedMemory, key: string): number | null {
  const offset = getOffset(mem, key);
  if (offset === null) return null;
  const type = mem.dataTable.getInt32(offset);
  if (type === 5) {
    return mem.getObjectId(offset);
  }
  const slot = mem.readValueSlot(offset);
  if (slot.type === TYPE_ARRAY_REF) {
    return mem.getArrayObjectId(slot.a);
  }
  return null;
}

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

/**
 * Deep-ish copy of a decoded value, so callers can't corrupt the cache.
 *
 * Uses `Object.assign` for the fast shallow copy, then a `for...in` pass to
 * copy any nested arrays (so mutating a returned array property cannot corrupt
 * the cache). This is ~4.5× faster than the previous `Object.entries` + spread
 * loop, which allocated an entries array and re-checked `Array.isArray` on
 * every property.
 */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value !== null && typeof value === "object") {
    const copy = Object.assign({} as Record<string, unknown>, value);
    for (const k in copy) {
      if (Array.isArray(copy[k])) copy[k] = [...(copy[k] as unknown[])];
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
  /**
   * A worker-side reference-count tracker. When provided, `read()` acquires a
   * reference to the returned object/array, released when it is GC'd.
   */
  refCount?: RefCountTracker;
  /**
   * Initial capacity (in elements) reserved for arrays when they are first
   * stored. Arrays are created with this many slots, so subsequent `push`
   * calls can append in place without growing/moving the array until the
   * capacity is exhausted. Defaults to the array's length.
   */
  arrayCapacity?: number;
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

  const mem = options.memory ?? getDefaultMemory();
  const ref = createSharedRef<T>(
    mem,
    key,
    typeof initialOrLoader === "function" ? undefined : (initialOrLoader as T),
    options.refCount ?? getDefaultTracker() ?? undefined,
    options.arrayCapacity,
  );
  registry.set(key, ref as SharedRef<unknown>);

  if (typeof initialOrLoader === "function") {
    return Promise.resolve((initialOrLoader as Loader<T>)()).then((value) => {
      ref.write(value);
      return ref;
    });
  }

  // If the key already exists in shared memory (e.g. it was created by the
  // main thread and this is a worker sharing the same buffers), don't
  // overwrite it with the initial value.
  if (getOffset(mem, key) === null) {
    ref.write(initialOrLoader as T);
  }
  return ref;
}

/**
 * Read a single property of a shared object value.
 *
 * Shared by the proxy `get` handler and the generated accessor getters. Uses
 * the lock-free read-cache fast path and falls back to `readValue` (which
 * fills the cache) on a miss. Array properties are returned as an array proxy.
 */
function readProp(
  mem: SharedMemory,
  key: string,
  prop: string | symbol,
  arrayCapacity?: number,
): unknown {
  const fast = readCachedValue(mem, key);
  const value = fast.hit ? fast.value : readValue(mem, key);
  if (Array.isArray(value)) {
    return getTopLevelArrayMember(mem, key, value, prop, arrayCapacity);
  }
  const propValue = (value as Record<string | symbol, unknown>)[prop];
  if (Array.isArray(propValue)) {
    return createArrayProxy(mem, key, prop as string, arrayCapacity);
  }
  return propValue;
}

/**
 * Read a single object property for the per-property accessor cache, decoding
 * only the requested slot (not the whole object) and caching the decoded value
 * in `fieldCache` under the observed version. Array properties are cached as
 * an array proxy so subsequent reads hit the fast path.
 *
 * This is the miss path for the object accessor getters; the hit path returns
 * `fieldCache.value` directly.
 */
function readObjectProp(
  mem: SharedMemory,
  key: string,
  prop: string,
  fieldCache: { version: number; value: unknown },
  version: number,
  arrayCapacity?: number,
): unknown {
  const layout = getObjectLayout(mem, key);
  if (layout === null) {
    // Not an object (shouldn't happen for an object accessor); fall back.
    return readProp(mem, key, prop, arrayCapacity);
  }
  const slotOffset = layout.properties.get(prop);
  if (slotOffset === undefined) {
    throw new TypeError(
      `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
    );
  }
  const slot = mem.readValueSlot(slotOffset);
  let value = decodeValue(mem, slot);
  if (Array.isArray(value)) {
    value = createArrayProxy(mem, key, prop, arrayCapacity);
  }
  fieldCache.version = version;
  fieldCache.value = value;
  return value;
}

/**
 * Write a single property of a shared object value in place.
 *
 * Shared by the proxy `set` handler and the generated accessor setters. Uses
 * the cached layout to update only the affected slot.
 */
function writeProp(
  mem: SharedMemory,
  key: string,
  prop: string | symbol,
  val: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  // Inline writeLock to avoid a closure allocation on the hot path.
  mem.beginWrite();
  if (mem.isDefragmenting()) {
    mem.endWrite();
    mem.withLock(() =>
      writePropInner(mem, key, prop, val, arrayCapacity, target),
    );
    return;
  }
  try {
    writePropInner(mem, key, prop, val, arrayCapacity, target);
  } finally {
    mem.endWrite();
  }
}

function writePropInner(
  mem: SharedMemory,
  key: string,
  prop: string | symbol,
  val: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  // If the slot type is already cached on the target, we can skip the
  // getObjectLayout Map lookup for top-level arrays (which are never objects).
  const knownType = target?.__type;
  if (knownType !== TYPE_ARRAY_REF) {
    // Object property: use the cached layout to write only that slot.
    const layout = getObjectLayout(mem, key);
    if (layout !== null) {
      const slotOffset = layout.properties.get(prop as string);
      if (slotOffset === undefined) {
        throw new TypeError(
          `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
        );
      }
      if (typeof val === "number") {
        // Fast path: numbers need no old-slot read (freeSlotRefs is a no-op)
        // and no in-place string reuse; write the float64 directly.
        mem.updateNumberSlot(slotOffset, val);
        bumpTarget(mem, key, target);
        return;
      }
      if (typeof val === "string") {
        // Fast path: short strings are written inline into the slot itself.
        if (mem.updateInlineStringSlot(slotOffset, val)) {
          bumpTarget(mem, key, target);
          return;
        }
      }
      const oldSlot = mem.readValueSlot(slotOffset);
      freeSlotRefs(mem, oldSlot);
      mem.updateValueSlot(
        slotOffset,
        encodeValue(mem, val, arrayCapacity, oldSlot),
      );
      bumpTarget(mem, key, target);
      return;
    }
  }

  // Top-level array index write: update only that array slot.
  const offset = getCachedOffset(mem, key, target);
  if (offset === null) {
    throw new Error(`No shared value found for key "${key}"`);
  }
  const slotType =
    target !== undefined && target.__type !== undefined
      ? target.__type
      : mem.dataTable.getInt32(offset);
  if (target !== undefined && target.__type === undefined) {
    target.__type = slotType;
  }
  if (
    slotType === TYPE_ARRAY_REF &&
    typeof prop === "string" &&
    /^\d+$/.test(prop)
  ) {
    const index = Number(prop);
    // Use the cached ArrayRef when it is still valid (same layout version,
    // i.e. no defragmentation or array growth has moved it). Otherwise
    // re-read the 3 header Int32s and refresh the cache.
    let ref = target?.__arrayRef;
    if (
      ref === undefined ||
      target!.__arrayRefLayoutVersion !== mem.getLayoutVersion()
    ) {
      ref = {
        offset: mem.dataTable.getInt32(offset + 4),
        count: mem.dataTable.getInt32(offset + 8),
        capacity: mem.dataTable.getInt32(offset + 12),
      };
      if (target !== undefined) {
        target.__arrayRef = ref;
        target.__arrayRefLayoutVersion = mem.getLayoutVersion();
      }
    }
    if (index >= ref.count) {
      throw new RangeError(
        `Index ${index} out of bounds for array of length ${ref.count}`,
      );
    }
    if (typeof val === "number") {
      // Fast path: numbers need no old-slot read (freeSlotRefs is a no-op).
      mem.updateArrayNumberSlot(ref, index, val);
      bumpTarget(mem, key, target);
      return;
    }
    if (typeof val === "boolean") {
      // Fast path: booleans need no old-slot read (freeSlotRefs is a no-op).
      mem.updateArrayBooleanSlot(ref, index, val);
      bumpTarget(mem, key, target);
      return;
    }
    if (typeof val === "string") {
      // Fast path: short strings are written inline into the array slot.
      if (mem.updateArrayInlineStringSlot(ref, index, val)) {
        bumpTarget(mem, key, target);
        return;
      }
    }
    freeSlotRefs(mem, mem.readArraySlot(ref, index));
    mem.updateArraySlot(ref, index, encodeValue(mem, val));
    bumpTarget(mem, key, target);
    return;
  }

  // Top-level array length write: shrink/grow the array in place.
  if (slotType === TYPE_ARRAY_REF && prop === "length") {
    const newLen = Number(val);
    if (!Number.isInteger(newLen) || newLen < 0) {
      throw new RangeError("Invalid array length");
    }
    const ref = {
      offset: mem.dataTable.getInt32(offset + 4),
      count: mem.dataTable.getInt32(offset + 8),
      capacity: mem.dataTable.getInt32(offset + 12),
    };
    if (newLen <= ref.capacity) {
      mem.updateValueSlot(
        offset,
        arrayRefSlot({
          offset: ref.offset,
          count: newLen,
          capacity: ref.capacity,
        }),
      );
      bumpTarget(mem, key, target);
      return;
    }
  }

  // Fallback: full read-modify-write.
  mutateValue<unknown, boolean>(
    mem,
    key,
    (value) => {
      if (Array.isArray(value)) {
        (value as unknown as Record<string | symbol, unknown>)[prop] = val;
      } else {
        (value as Record<string | symbol, unknown>)[prop] = val;
      }
      return true;
    },
    arrayCapacity,
  );
}

/** Create a SharedRef proxy backed by a SharedMemory instance. */
function createSharedRef<T>(
  mem: SharedMemory,
  key: string,
  initialValue: T | undefined,
  tracker?: RefCountTracker,
  arrayCapacity?: number,
): SharedRef<T> {
  const target = {
    key,
    mem,
    // Fast-path cache: mirrors the module-level readCache entry for this key
    // so the proxy get handler can read it without a Map lookup. Invalidated
    // on every local write/update; cross-worker invalidation is detected by
    // the version check in the get handler.
    __cache: undefined as
      { version: number; value: unknown; index: number } | undefined,
    // Cached DataTable offset for this key, valid only while the global
    // layout version is unchanged (i.e. no defragmentation has moved it).
    // Mirrors the module-level offsetCache to avoid a Map lookup on the
    // write hot path.
    __offset: undefined as number | undefined,
    __layoutVersion: -1,
    // Cached slot type for this key, so the write hot path can skip the
    // DataTable type read when the value's type is known to be stable.
    __type: undefined as number | undefined,
    // Cached ArrayRef for a top-level array value, so the write hot path can
    // skip re-reading the 3 header Int32s on every index write. Valid only
    // while the global layout version is unchanged (no defragmentation) and
    // while the array has not grown past the cached count (checked by the
    // caller via `index < ref.count`).
    __arrayRef: undefined as
      { offset: number; count: number; capacity: number } | undefined,
    __arrayRefLayoutVersion: -1,
    // Cached version-cell index for this key, so the write hot path can bump
    // the version cell without a Map lookup. Stable for the key's lifetime.
    __index: undefined as number | undefined,
    read: () => {
      const value = copyValue(readValue(mem, key, target)) as T;
      if (tracker && isTrackable(value)) {
        const objectId = getTopLevelObjectId(mem, key);
        if (objectId !== null) tracker.track(value as object, objectId);
      }
      return value;
    },
    write: (value: T) => {
      target.__cache = undefined;
      writeValue(mem, key, value, arrayCapacity, target);
    },
    update: (fn: (current: T) => T) => {
      target.__cache = undefined;
      return updateValue(mem, key, fn, arrayCapacity);
    },
  };

  // Determine the object's property names so we can hard-bake accessor
  // getters/setters instead of routing every access through a Proxy trap.
  // The shape is known from the initial value (if it is an object) or from
  // shared memory (if the key already exists, e.g. in a worker).
  let propNames: string[] | null = null;
  if (
    initialValue !== null &&
    typeof initialValue === "object" &&
    !Array.isArray(initialValue)
  ) {
    propNames = Object.keys(initialValue as Record<string, unknown>);
  } else {
    const layout = mem.withLock(() => mem.getObjectLayout(key));
    if (layout !== null) {
      propNames = [...layout.properties.keys()];
    }
  }

  // Object values: return a plain object with hard-baked accessor getters and
  // setters (no Proxy). This avoids the Proxy trap overhead on every property
  // read (~2.6× faster) and stays a plain, serializable object.
  if (propNames !== null && propNames.length > 0) {
    // Methods live on the prototype, not on the object itself. Keeping the
    // data properties as the only own properties lets the JIT treat the
    // object as monomorphic, which is ~2× faster for accessor reads than
    // having extra own properties (read/write/update/key/buffer).
    const proto: Record<string | symbol, unknown> = {
      [Symbol.toPrimitive]: () => target.read(),
    };
    Object.defineProperty(proto, "read", {
      enumerable: false,
      configurable: false,
      value: target.read,
    });
    Object.defineProperty(proto, "write", {
      enumerable: false,
      configurable: false,
      value: target.write,
    });
    Object.defineProperty(proto, "update", {
      enumerable: false,
      configurable: false,
      value: target.update,
    });
    // key/buffer are non-enumerable so they don't appear in JSON.stringify /
    // Object.keys (matching the previous Proxy behavior).
    Object.defineProperty(proto, "key", {
      enumerable: false,
      configurable: false,
      value: key,
    });
    Object.defineProperty(proto, "buffer", {
      enumerable: false,
      configurable: false,
      get() {
        return mem.dataTable.buffers[0];
      },
    });
    const ref = Object.create(proto) as Record<string | symbol, unknown>;
    // Resolve the object's stable version-cell index lazily (the value may not
    // be written to shared memory until after this accessor is built) and cache
    // it so the hot getter can load the version cell directly without a Map
    // lookup or an index→cell computation on every read. The cell index is
    // stable for the key's lifetime (the Index Table is never reordered).
    let cellIndex: number | null = null;
    for (const name of propNames) {
      // Per-property cache slot bound to this getter closure (mirrors
      // cofusion's per-field `desc.cachedVer`/`desc.cachedVal`). On a cache
      // hit the getter returns the already-decoded value directly, avoiding
      // the `readCache` Map hash lookup and the whole-object `v[name]`
      // extraction on the hot path.
      const fieldCache: { version: number; value: unknown } = {
        version: -1,
        value: undefined,
      };
      // Stable array proxy for this property, cached across writes. A write
      // bumps the version and invalidates `fieldCache`, which would otherwise
      // recreate the array proxy on every access. The proxy reads fresh data
      // on each access, so it stays correct without being recreated.
      let arrayProxy: unknown[] | undefined;
      Object.defineProperty(ref, name, {
        enumerable: true,
        configurable: false,
        get() {
          // Lock-free fast path inlined so the JIT can optimize the hot
          // cache-hit read without a function-call chain.
          if (cellIndex === null) {
            cellIndex = mem.getVersionCellIndex(getIndex(mem, key));
          }
          const version = Atomics.load(mem.versionView, cellIndex);
          if (fieldCache.version === version) {
            return fieldCache.value;
          }
          // If this property is an array, return the stable cached proxy
          // (which reads fresh data on each access) instead of recreating it
          // on every write.
          if (arrayProxy !== undefined) {
            return arrayProxy;
          }
          const value = readObjectProp(
            mem,
            key,
            name,
            fieldCache,
            version,
            arrayCapacity,
          );
          if (Array.isArray(value)) {
            arrayProxy = value;
          }
          return value;
        },
        set(v: unknown) {
          target.__cache = undefined;
          writeProp(mem, key, name, v, arrayCapacity, target);
        },
      });
    }
    // Fixed shape: reject adding new properties (throws in strict mode).
    Object.preventExtensions(ref);
    return ref as unknown as SharedRef<T>;
  }

  // Arrays, primitives, or unknown shape: use a Proxy (index access, array
  // methods, and dynamic properties require interception).
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "read") return t.read;
      if (prop === "write") return t.write;
      if (prop === "update") return t.update;
      if (prop === "key") return t.key;
      if (prop === "buffer") return mem.dataTable.buffers[0];
      if (prop === Symbol.toPrimitive) return () => t.read();

      // push/pop on a top-level array: operate directly on the array ref
      // without decoding the whole array (O(1) amortized).
      if (prop === "push" || prop === "pop") {
        const slotOffset = findArrayRefSlot(mem, key, null);
        if (slotOffset !== null) {
          return (...args: unknown[]) =>
            mutateArrayRef(mem, key, null, prop, args);
        }
      }

      return readProp(mem, key, prop, arrayCapacity);
    },
    set(t, prop, val) {
      t.__cache = undefined;
      writeProp(mem, key, prop, val, arrayCapacity, t);
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
 * Lock-free fast path: if the cached version matches the current version cell,
 * the cached value is still valid. Returns the cached value, or a miss marker.
 * Kept small so the JIT can inline it into hot accessor getters.
 */
function readCachedValue(
  mem: SharedMemory,
  key: string,
): { hit: true; value: unknown } | { hit: false } {
  const cached = readCache.get(key);
  if (cached !== undefined && cached.version === mem.getVersion(cached.index)) {
    return { hit: true, value: cached.value };
  }
  return { hit: false };
}

/**
 * Read the full value for a key from shared memory, using the read cache.
 *
 * When `cacheTarget` is provided (the proxy target), the cache entry is also
 * mirrored onto `cacheTarget.__cache` so the proxy get handler can read it
 * without a Map lookup on the hot path.
 */
function readValue(
  mem: SharedMemory,
  key: string,
  cacheTarget?: {
    __cache?: { version: number; value: unknown; index: number };
  },
): unknown {
  const fast = readCachedValue(mem, key);
  if (fast.hit) return fast.value;

  const cached = readCache.get(key);
  const index = cached !== undefined ? cached.index : getIndex(mem, key);
  const version = mem.getVersion(index);

  // Cache miss: decode under the lock and cache with the observed version.
  const value = mem.withLock(() => {
    const offset = getOffset(mem, key);
    if (offset === null) {
      throw new Error(`No shared value found for key "${key}"`);
    }
    const type = mem.dataTable.getInt32(offset);
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

  const entry = { version, value, index };
  readCache.set(key, entry);
  if (cacheTarget) cacheTarget.__cache = entry;
  return value;
}

/** Write a full value for a key to shared memory. */
function writeValue(
  mem: SharedMemory,
  key: string,
  value: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  // Inline writeLock to avoid a closure allocation on the hot path.
  mem.beginWrite();
  if (mem.isDefragmenting()) {
    mem.endWrite();
    mem.withLock(() => writeValueInner(mem, key, value, arrayCapacity, target));
    return;
  }
  try {
    writeValueInner(mem, key, value, arrayCapacity, target);
  } finally {
    mem.endWrite();
  }
}

function writeValueInner(
  mem: SharedMemory,
  key: string,
  value: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  const existing = getCachedOffset(mem, key, target);
  if (existing !== null) {
    // Skip the DataTable type read when the slot type is known to be stable
    // (cached on the target). Only re-read when the type is unknown.
    let type = target?.__type;
    if (type === undefined) {
      type = mem.dataTable.getInt32(existing);
      if (target !== undefined) target.__type = type;
    }
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
        // Free the old referenced blocks (array/string) before overwriting.
        const oldPropSlot = properties[i]![1];
        freeSlotRefs(mem, oldPropSlot);
        mem.updateObjectSlot(
          existing,
          i,
          encodeValue(mem, valueObj[name], arrayCapacity, oldPropSlot),
        );
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
      bumpTarget(mem, key, target);
      return;
    }
    // Update a single value slot in place.
    if (typeof value === "number") {
      // Fast path: numbers need no old-slot read (freeSlotRefs is a no-op)
      // and no in-place string reuse; write the float64 directly.
      mem.updateNumberSlot(existing, value);
      bumpTarget(mem, key, target);
      return;
    }
    const isPrimitive = typeof value === "boolean" || typeof value === "bigint";
    if (isPrimitive) {
      // Fast path: primitives need no old-slot read (freeSlotRefs is a
      // no-op) and no in-place string reuse.
      if (typeof value === "boolean") {
        mem.updateBooleanSlot(existing, value);
      } else {
        mem.updateValueSlot(existing, encodeValue(mem, value, arrayCapacity));
      }
      bumpTarget(mem, key, target);
      return;
    }
    if (typeof value === "string") {
      // Fast path: short strings are written inline into the slot itself,
      // avoiding a heap allocation and the string-table write. Longer strings
      // read the old string ref directly (no ValueSlot object allocation) so
      // storeStringValue can reuse the block in place.
      if (mem.updateInlineStringSlot(existing, value)) {
        bumpTarget(mem, key, target);
        return;
      }
      const oldType = mem.dataTable.getInt32(existing);
      const oldA = mem.dataTable.getInt32(existing + 4);
      const oldB = mem.dataTable.getInt32(existing + 8);
      const ref = mem.storeStringValue(
        value,
        oldType === TYPE_STRING_VALUE_REF
          ? { offset: oldA, length: oldB }
          : undefined,
      );
      mem.updateValueSlot(existing, stringValueRefSlot(ref));
      bumpTarget(mem, key, target);
      return;
    }
    const oldSlot = mem.readValueSlot(existing);
    freeSlotRefs(mem, oldSlot);
    mem.updateValueSlot(
      existing,
      encodeValue(mem, value, arrayCapacity, oldSlot),
    );
    bumpTarget(mem, key, target);
    return;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // Create a new object.
    const valueObj = value as Record<string, unknown>;
    const props: Array<[string, ValueSlot]> = Object.entries(valueObj).map(
      ([name, v]) => [name, encodeValue(mem, v, arrayCapacity)],
    );
    const offset = mem.createObject(props);
    mem.insert(key, offset);
    const lv = mem.getLayoutVersion();
    offsetCache.set(key, { offset, layoutVersion: lv });
    if (target !== undefined) {
      target.__offset = offset;
      target.__layoutVersion = lv;
      target.__type = undefined;
      target.__arrayRef = undefined;
    }
    return;
  }

  // Create a single value slot (primitive or array).
  const offset = mem.storeValueSlot(encodeValue(mem, value, arrayCapacity));
  mem.insert(key, offset);
  const lv = mem.getLayoutVersion();
  offsetCache.set(key, { offset, layoutVersion: lv });
  if (target !== undefined) {
    target.__offset = offset;
    target.__layoutVersion = lv;
    target.__type = undefined;
    target.__arrayRef = undefined;
  }
}

/** Bump the version cell for a key, invalidating read caches. */
function bump(mem: SharedMemory, key: string): void {
  mem.bumpVersion(getIndex(mem, key));
}

/**
 * Bump the version cell for a key using the target's cached index, avoiding
 * the `getIndex` Map lookup on the write hot path. Falls back to `bump` when
 * the index is not yet cached.
 */
function bumpTarget(
  mem: SharedMemory,
  key: string,
  target?: WriteTarget,
): void {
  if (target !== undefined && target.__index !== undefined) {
    mem.bumpVersion(target.__index);
    return;
  }
  const index = getIndex(mem, key);
  if (target !== undefined) target.__index = index;
  mem.bumpVersion(index);
}

/** Atomically update the value for a key. */
function updateValue<T>(
  mem: SharedMemory,
  key: string,
  fn: (current: T) => T,
  arrayCapacity?: number,
): T {
  return writeLock(mem, () => {
    const current = readValue(mem, key) as T;
    const next = fn(current);
    writeValue(mem, key, next, arrayCapacity);
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
  arrayCapacity?: number,
): R {
  return writeLock(mem, () => {
    const current = readValue(mem, key) as T;
    const result = fn(current);
    writeValue(mem, key, current, arrayCapacity);
    return result;
  });
}

/**
 * Find the DataTable offset of the array-ref slot for a key's array.
 *
 * `prop` is null for a top-level array value, or the property name for an
 * array property of an object. Returns null if the value is not an array.
 */
function findArrayRefSlot(
  mem: SharedMemory,
  key: string,
  prop: string | null,
): number | null {
  if (prop === null) {
    const offset = getOffset(mem, key);
    if (offset === null) return null;
    const slot = mem.readValueSlot(offset);
    return slot.type === TYPE_ARRAY_REF ? offset : null;
  }
  const layout = getObjectLayout(mem, key);
  if (layout === null) return null;
  const slotOffset = layout.properties.get(prop);
  if (slotOffset === undefined) return null;
  const slot = mem.readValueSlot(slotOffset);
  return slot.type === TYPE_ARRAY_REF ? slotOffset : null;
}

/**
 * O(1) in-place push/pop on a shared array ref, without decoding or
 * re-encoding the whole array. `prop` is null for a top-level array, or the
 * property name for an array property of an object.
 */
function mutateArrayRef(
  mem: SharedMemory,
  key: string,
  prop: string | null,
  method: "push" | "pop",
  args: unknown[],
): unknown {
  return writeLock(mem, () => {
    const slotOffset = findArrayRefSlot(mem, key, prop);
    if (slotOffset === null) {
      throw new TypeError("Value is not an array");
    }
    const slot = mem.readValueSlot(slotOffset);
    const ref: ArrayRef = { offset: slot.a, count: slot.b, capacity: slot.c };

    if (method === "push") {
      for (const arg of args) {
        const next = mem.appendArraySlot(ref, encodeValue(mem, arg));
        // Always persist the new count (and offset/capacity if moved).
        mem.updateValueSlot(slotOffset, arrayRefSlot(next));
        ref.offset = next.offset;
        ref.count = next.count;
        ref.capacity = next.capacity;
      }
      bump(mem, key);
      return ref.count;
    }

    // pop
    if (ref.count === 0) {
      return undefined;
    }
    // Read the last element before decrementing.
    const lastSlot = mem.readArraySlot(ref, ref.count - 1);
    const result = decodeValue(mem, lastSlot);
    // Free the removed element's referenced blocks (array/string).
    freeSlotRefs(mem, lastSlot);
    const next = {
      offset: ref.offset,
      count: ref.count - 1,
      capacity: ref.capacity,
    };
    mem.updateValueSlot(slotOffset, arrayRefSlot(next));
    bump(mem, key);
    return result;
  });
}

/** Get a member of a top-level array value, with read-modify-write for mutating methods. */
function getTopLevelArrayMember(
  mem: SharedMemory,
  key: string,
  value: unknown[],
  prop: string | symbol,
  arrayCapacity?: number,
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
    // push/pop are O(1) in-place operations on the array ref.
    if (methodName === "push" || methodName === "pop") {
      return (...args: unknown[]) => {
        return mutateArrayRef(mem, key, null, methodName, args);
      };
    }
    return (...args: unknown[]) => {
      return mutateValue<unknown[], unknown>(
        mem,
        key,
        (fresh) => {
          const method = (
            fresh as unknown as Record<string, (...a: unknown[]) => unknown>
          )[methodName]!;
          return method.apply(fresh, args);
        },
        arrayCapacity,
      );
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
  arrayCapacity?: number,
): unknown[] {
  // Cache the object's property slot offset and the array ref so index writes
  // skip the per-write getObjectLayout Map lookup, properties.get, and the
  // DataTable header reads. Invalidated when the layout version changes
  // (defragmentation or array growth via moveArray).
  let cachedSlotOffset: number | undefined;
  let cachedRef:
    { offset: number; count: number; capacity: number } | undefined;
  let cachedLayoutVersion = -1;
  return new Proxy([] as unknown[], {
    get(_target, arrProp) {
      // push/pop on an array property: operate directly on the array ref
      // without decoding the whole object (O(1) amortized).
      if (arrProp === "push" || arrProp === "pop") {
        const slotOffset = findArrayRefSlot(mem, key, prop);
        if (slotOffset !== null) {
          return (...args: unknown[]) =>
            mutateArrayRef(mem, key, prop, arrProp, args);
        }
      }
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
        // push/pop are O(1) in-place operations on the array ref.
        if (methodName === "push" || methodName === "pop") {
          return (...args: unknown[]) => {
            return mutateArrayRef(mem, key, prop, methodName, args);
          };
        }
        return (...args: unknown[]) => {
          return mutateValue<Record<string, unknown>, unknown>(
            mem,
            key,
            (fresh) => {
              const freshArr = fresh[prop] as unknown[];
              const method = (
                freshArr as unknown as Record<
                  string,
                  (...a: unknown[]) => unknown
                >
              )[methodName]!;
              return method.apply(freshArr, args);
            },
            arrayCapacity,
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
      return writeLock(mem, () => {
        // Refresh the cached slot offset when the layout version changed
        // (defragmentation may have moved the object block).
        if (cachedLayoutVersion !== mem.getLayoutVersion()) {
          cachedSlotOffset = undefined;
          cachedRef = undefined;
          cachedLayoutVersion = mem.getLayoutVersion();
        }
        if (cachedSlotOffset === undefined) {
          const layout = getObjectLayout(mem, key);
          if (layout === null) {
            // Fallback: full read-modify-write.
            return mutateValue<Record<string, unknown>, boolean>(
              mem,
              key,
              (fresh) => {
                const arr = fresh[prop] as unknown[];
                (arr as unknown as Record<string | symbol, unknown>)[arrProp] =
                  val;
                return true;
              },
              arrayCapacity,
            );
          }
          const so = layout.properties.get(prop);
          if (so === undefined) {
            throw new TypeError(
              `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
            );
          }
          cachedSlotOffset = so;
        }
        const propSlot = mem.readValueSlot(cachedSlotOffset);
        if (
          propSlot.type === TYPE_ARRAY_REF &&
          typeof arrProp === "string" &&
          /^\d+$/.test(arrProp)
        ) {
          const index = Number(arrProp);
          // Use the cached ref when valid; re-read when the array may have
          // grown past the cached count (push) or the layout changed.
          let ref = cachedRef;
          if (
            ref === undefined ||
            index >= ref.count ||
            cachedLayoutVersion !== mem.getLayoutVersion()
          ) {
            ref = {
              offset: propSlot.a,
              count: propSlot.b,
              capacity: propSlot.c,
            };
            cachedRef = ref;
          }
          if (index >= ref.count) {
            throw new RangeError(
              `Index ${index} out of bounds for array of length ${ref.count}`,
            );
          }
          if (typeof val === "number") {
            // Fast path: numbers need no old-slot read (freeSlotRefs is a
            // no-op) and no in-place string reuse.
            mem.updateArrayNumberSlot(ref, index, val);
            bump(mem, key);
            return true;
          }
          if (typeof val === "boolean") {
            // Fast path: booleans need no old-slot read (freeSlotRefs is a
            // no-op).
            mem.updateArrayBooleanSlot(ref, index, val);
            bump(mem, key);
            return true;
          }
          if (typeof val === "string") {
            // Fast path: short strings are written inline into the slot.
            if (mem.updateArrayInlineStringSlot(ref, index, val)) {
              bump(mem, key);
              return true;
            }
          }
          freeSlotRefs(mem, mem.readArraySlot(ref, index));
          mem.updateArraySlot(ref, index, encodeValue(mem, val));
          bump(mem, key);
          return true;
        }
        // Array property length write: shrink/grow in place without
        // re-encoding the whole object (which would leave a dead slot).
        if (propSlot.type === TYPE_ARRAY_REF && arrProp === "length") {
          const newLen = Number(val);
          if (!Number.isInteger(newLen) || newLen < 0) {
            throw new RangeError("Invalid array length");
          }
          const ref = {
            offset: propSlot.a,
            count: propSlot.b,
            capacity: propSlot.c,
          };
          if (newLen <= ref.capacity) {
            mem.updateValueSlot(
              cachedSlotOffset,
              arrayRefSlot({
                offset: ref.offset,
                count: newLen,
                capacity: ref.capacity,
              }),
            );
            bump(mem, key);
            return true;
          }
          // Growing beyond capacity falls through to the full read-modify-write.
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
          arrayCapacity,
        );
      });
    },
  });
}
