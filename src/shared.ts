import {
  SharedMemory,
  TYPE_ARRAY_REF,
  TYPE_BIGINT_STR,
  TYPE_INLINE_STRING,
  TYPE_KEY_REF,
  TYPE_NULL,
  TYPE_OBJECT_REF,
  TYPE_STRING_REF,
  TYPE_STRING_VALUE_REF,
  arrayRefSlot,
  bigintSlot,
  bigintStrSlot,
  booleanSlot,
  decodeSlot,
  keyRefSlot,
  nullSlot,
  numberSlot,
  objectRefSlot,
  stringRefSlot,
  stringValueRefSlot,
  type ArrayRef,
  type ObjectLayout,
  type StringRef,
  type ValueSlot,
} from "./memory.ts";
import type { RefCountTracker } from "./refcount.ts";
import type { RWLock } from "./rwlock.ts";
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
 * A single step in the path to a nested array. The first step may be a
 * property name (an array property of a shared object); all subsequent steps
 * are array indices.
 */
type ArrayStep =
  { kind: "prop"; name: string } | { kind: "index"; index: number };

/**
 * Locates an array within shared memory. `path` is empty for a top-level
 * array value, `[{kind:"prop",name}]` for an array property of a shared
 * object, and longer for nested arrays (e.g. `[{kind:"index",index:0}]` for
 * `arr[0]`).
 */
interface ArrayLocator {
  key: string;
  path: ArrayStep[];
}

/**
 * Run a write operation. Writes are serialized under the shared mutex so that
 * concurrent writers to the same value cannot lose updates or interleave a
 * multi-step write. The mutex is re-entrant, so a write that internally calls
 * another write (e.g. `updateValue`) does not deadlock. It also protects
 * writers against racing a defragmentation pass, which runs under the same
 * lock.
 */
function writeLock<T>(mem: SharedMemory, fn: () => T): T {
  return mem.withLock(fn);
}

/** Inclusive bounds of a signed 64-bit integer (stored as a fast int64 slot). */
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

/**
 * Convert a JS value into a ValueSlot, storing strings/arrays/objects in
 * tables.
 *
 * `visited` tracks plain objects being encoded in the current recursion to
 * break cyclic plain-object graphs (which have no representation in the
 * object-block structure). Nested `Shared` objects are stored as live key
 * references instead of being copied, so self/mutual references never recurse
 * and changes stay in sync.
 */
function encodeValue(
  mem: SharedMemory,
  value: unknown,
  arrayCapacity?: number,
  oldSlot?: ValueSlot,
  visited?: Set<object>,
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
          ? {
              offset: oldSlot.a,
              length: oldSlot.b,
              reserved: oldSlot.c || undefined,
            }
          : undefined;
      return stringValueRefSlot(mem.storeStringValue(value, oldRef));
    default:
      if (value === null) {
        // `null` is a supported value (stored as TYPE_NULL). `undefined` is
        // intentionally still rejected below.
        return nullSlot();
      }
      if (Array.isArray(value)) {
        // Nested arrays are stored as array-refs in the parent array's slots
        // (recursively). Elements may be any encodable value (primitives,
        // nested arrays, nested objects, or live shared references).
        const slots = value.map((v) =>
          encodeValue(mem, v, arrayCapacity, undefined, visited),
        );
        return arrayRefSlot(mem.storeArray(slots, arrayCapacity));
      }
      if (value !== null && typeof value === "object") {
        // A nested SharedRef: store a live reference to its key so the two
        // stay in sync and self/mutual references don't recurse.
        const sharedKey = sharedKeyMap.get(value as object);
        if (sharedKey !== undefined) {
          const index = getIndex(mem, sharedKey);
          return keyRefSlot(index);
        }
        // A plain nested object: store it as a nested object block.
        if (visited === undefined) visited = new Set<object>();
        if (visited.has(value as object)) {
          throw new TypeError(
            `Cannot store cyclic plain object: it is already being written`,
          );
        }
        visited.add(value as object);
        const valueObj = value as Record<string, unknown>;
        const props: Array<[string, ValueSlot]> = Object.entries(valueObj).map(
          ([name, v]) => [
            name,
            encodeValue(mem, v, arrayCapacity, undefined, visited),
          ],
        );
        const offset = mem.createObject(props);
        return objectRefSlot(offset);
      }
      throw new TypeError(
        `Cannot store value of type ${typeof value}: only primitives, bigints, arrays, and objects are allowed`,
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
    case TYPE_ARRAY_REF: // array-ref
      return mem
        .readArray({ offset: slot.a, count: slot.b, capacity: slot.c })
        .map((s) => decodeValue(mem, s));
    case TYPE_OBJECT_REF: {
      // Nested object block: decode its properties recursively.
      const properties = mem.readObject(slot.a);
      const obj: Record<string, unknown> = {};
      for (const [name, s] of properties) {
        obj[name] = decodeValue(mem, s);
      }
      return obj;
    }
    case TYPE_KEY_REF: {
      // Live reference to another shared key: return a live wrapper so the
      // two stay in sync. Resolving to a reference (not its contents) is what
      // prevents infinite recursion on self/mutual references.
      const key = mem.getKeyByIndex(slot.a);
      return key === null ? undefined : getNestedSharedRef(mem, key);
    }
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
      /** Run `fn` while holding an exclusive write lock on this value. */
      withRWLock<R>(fn: (self: SharedRef<T>) => R): R;
      /** Run `fn` while holding the write lock (alias of `withRWLock`). */
      withWriteLock<R>(fn: (self: SharedRef<T>) => R): R;
      /**
       * Run `fn` while holding a read lock, allowing concurrent readers. Only
       * meaningful when a shared `RWLock` was provided; otherwise it falls
       * back to the shared mutex.
       */
      withReadLock<R>(fn: (self: SharedRef<T>) => R): R;
      readonly key: string;
      readonly buffer: SharedArrayBuffer;
    }
  : {
      read(): T;
      write(value: T): void;
      update(fn: (current: T) => T): T;
      /** Run `fn` while holding an exclusive write lock on this value. */
      withRWLock<R>(fn: (self: SharedRef<T>) => R): R;
      /** Run `fn` while holding the write lock (alias of `withRWLock`). */
      withWriteLock<R>(fn: (self: SharedRef<T>) => R): R;
      /**
       * Run `fn` while holding a read lock, allowing concurrent readers. Only
       * meaningful when a shared `RWLock` was provided; otherwise it falls
       * back to the shared mutex.
       */
      withReadLock<R>(fn: (self: SharedRef<T>) => R): R;
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
  { version: number; value: unknown; index: number; cell: number }
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
  lv?: number,
): number | null {
  if (target !== undefined && target.__offset !== undefined) {
    if (target.__layoutVersion === (lv ?? mem.getLayoutVersion())) {
      return target.__offset;
    }
    target.__offset = undefined;
    target.__type = undefined;
    target.__arrayRef = undefined;
  }
  const cached = offsetCache.get(key);
  if (cached !== undefined) {
    if (cached.layoutVersion === (lv ?? mem.getLayoutVersion())) {
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
    const currentLv = lv ?? mem.getLayoutVersion();
    offsetCache.set(key, { offset, layoutVersion: currentLv });
    if (target !== undefined) {
      target.__offset = offset;
      target.__layoutVersion = currentLv;
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
/**
 * Per-worker cache of a key's object layout: key -> { layout, layoutVersion }.
 *
 * Because object properties may not be added or removed, the layout is static
 * for the lifetime of the object, but a defragmentation pass can move the
 * object block (changing its property slot offsets). The cache is therefore
 * re-validated against the global layout version on each access (a single
 * Atomics.load), exactly like the offset cache.
 */
const layoutCache = new Map<
  string,
  { layout: ObjectLayout | null; version: number }
>();

/** Get (and cache) the stable layout of an object value, or null if not an object. */
function getObjectLayout(mem: SharedMemory, key: string): ObjectLayout | null {
  const cached = layoutCache.get(key);
  if (cached !== undefined && cached.version === mem.getLayoutVersion()) {
    return cached.layout;
  }
  const layout = mem.withLock(() => mem.getObjectLayout(key));
  layoutCache.set(key, { layout, version: mem.getLayoutVersion() });
  return layout;
}

/**
 * The resolved anchor of a nested object: either a plain object block in the
 * DataTable (kind `object`) or a live reference to another shared key (kind
 * `shared`).
 */
type NestedObjectAnchor =
  | { kind: "object"; offset: number }
  | { kind: "shared"; key: string; index: number };

/**
 * Navigate a locator path to the object value at its end, returning an anchor
 * that can be read/written in place. Returns null if the value at the locator
 * is not an object (or doesn't exist).
 *
 * The path may mix object-property and array-index steps (e.g. a nested object
 * inside an array, or an object property of a nested object). A `TYPE_OBJECT_REF`
 * resolves to an object block; a `TYPE_KEY_REF` resolves to the referenced
 * shared key (so changes stay in sync). Re-navigated on each access so
 * defragmentation-moved offsets are always current.
 */
function resolveNestedObject(
  mem: SharedMemory,
  locator: ArrayLocator,
): NestedObjectAnchor | null {
  const { key, path } = locator;
  if (path.length === 0) {
    const offset = getOffset(mem, key);
    if (offset === null) return null;
    return mem.dataTable.getInt32(offset) === 5 /* TYPE_OBJECT */
      ? { kind: "object", offset }
      : null;
  }

  type Curr = { kind: "obj"; offset: number } | { kind: "arr"; ref: ArrayRef };
  // Establish the root (top-level object block or array).
  let curr: Curr | null = null;
  const rootOffset = getOffset(mem, key);
  if (rootOffset === null) return null;
  if (mem.dataTable.getInt32(rootOffset) === 5 /* TYPE_OBJECT */) {
    curr = { kind: "obj", offset: rootOffset };
  } else {
    const rootSlot = mem.readValueSlot(rootOffset);
    if (rootSlot.type !== TYPE_ARRAY_REF) return null;
    curr = {
      kind: "arr",
      ref: { offset: rootSlot.a, count: rootSlot.b, capacity: rootSlot.c },
    };
  }

  let lastSlot: ValueSlot | null = null;
  for (let i = 0; i < path.length; i++) {
    const step = path[i]!;
    if (curr === null) return null;
    let s: ValueSlot;
    if (step.kind === "prop") {
      if (curr.kind !== "obj") return null;
      const layout = mem.getObjectLayoutAtOffset(curr.offset);
      if (layout === null) return null;
      const so = layout.properties.get(step.name);
      if (so === undefined) return null;
      s = mem.readValueSlot(so);
    } else {
      if (curr.kind !== "arr") return null;
      if (step.index >= curr.ref.count) return null;
      s = mem.readArraySlot(curr.ref, step.index);
    }
    lastSlot = s;
    // Descend into a container for the next step.
    if (s.type === TYPE_OBJECT_REF) {
      curr = { kind: "obj", offset: s.a };
    } else if (s.type === TYPE_ARRAY_REF) {
      curr = { kind: "arr", ref: { offset: s.a, count: s.b, capacity: s.c } };
    } else if (i < path.length - 1) {
      return null; // hit a primitive before the end of the path
    } else {
      curr = null;
    }
  }

  if (lastSlot === null) return null;
  if (lastSlot.type === TYPE_OBJECT_REF) {
    return { kind: "object", offset: lastSlot.a };
  }
  if (lastSlot.type === TYPE_KEY_REF) {
    const k = mem.getKeyByIndex(lastSlot.a);
    return k === null ? null : { kind: "shared", key: k, index: lastSlot.a };
  }
  return null;
}

/**
 * Create a live proxy for the nested object at `locator` (a plain nested
 * object block or a reference to another shared key). Property reads/writes go
 * through to shared memory in place, so changes stay in sync. If the nested
 * value is a reference to another shared key, the shared wrapper for that key
 * is returned directly.
 */
function createNestedObjectProxy(
  mem: SharedMemory,
  locator: ArrayLocator,
  arrayCapacity?: number,
): Record<string | symbol, unknown> | null {
  const anchor = resolveNestedObject(mem, locator);
  if (anchor === null) return null;
  if (anchor.kind === "shared") {
    return getNestedSharedRef(mem, anchor.key) as Record<
      string | symbol,
      unknown
    >;
  }

  const proxy = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === "read") {
        return () => copyValue(readValueAtLocator(mem, locator));
      }
      if (prop === "key") return locator.key;
      if (prop === "buffer") return mem.dataTable.buffers[0];
      const offset = resolveAnchorOffset(mem, locator);
      if (offset === null) return undefined;
      const layout = mem.withLock(() => mem.getObjectLayoutAtOffset(offset));
      if (layout === null) return undefined;
      const slotOffset = layout.properties.get(prop as string);
      if (slotOffset === undefined) return undefined;
      const slot = mem.readValueSlot(slotOffset);
      if (slot.type === TYPE_OBJECT_REF || slot.type === TYPE_KEY_REF) {
        return createNestedObjectProxy(
          mem,
          {
            key: locator.key,
            path: [...locator.path, { kind: "prop", name: prop as string }],
          },
          arrayCapacity,
        );
      }
      let value = decodeValue(mem, slot);
      if (Array.isArray(value)) {
        return createArrayProxy(
          mem,
          {
            key: locator.key,
            path: [...locator.path, { kind: "prop", name: prop as string }],
          },
          arrayCapacity,
        );
      }
      return value;
    },
    set(_t, prop, val) {
      const offset = resolveAnchorOffset(mem, locator);
      if (offset === null) {
        throw new TypeError("Value is not an object");
      }
      const layout = mem.withLock(() => mem.getObjectLayoutAtOffset(offset));
      if (layout === null) {
        throw new TypeError("Value is not an object");
      }
      const slotOffset = layout.properties.get(prop as string);
      if (slotOffset === undefined) {
        throw new TypeError(
          `Nested object has a fixed shape: properties may not be added or removed`,
        );
      }
      writeObjectSlot(mem, locator.key, slotOffset, val, arrayCapacity);
      return true;
    },
  });
  return proxy;
}

/**
 * Re-resolve a locator that is known to point at a plain object block and
 * return its current DataTable offset, or null if it no longer points at one
 * (e.g. the value was replaced). Re-navigates from the root so
 * defragmentation-moved offsets are always current.
 */
function resolveAnchorOffset(
  mem: SharedMemory,
  locator: ArrayLocator,
): number | null {
  const anchor = resolveNestedObject(mem, locator);
  return anchor !== null && anchor.kind === "object" ? anchor.offset : null;
}

/**
 * Decode the (plain) value at a locator by reading the root through the read
 * cache and navigating the path. Used by the nested object proxy's `read()`.
 */
function readValueAtLocator(mem: SharedMemory, locator: ArrayLocator): unknown {
  const root = readValue(mem, locator.key);
  return readPathValue(mem, locator, root);
}

/**
 * Deep-ish copy of a decoded value, so callers can't corrupt the cache.
 *
 * Uses `Object.assign` for the fast shallow copy, then a `for...in` pass to
 * recursively copy any nested arrays (so mutating a returned array property
 * cannot corrupt the cache). This is ~4.5× faster than the previous
 * `Object.entries` + spread loop, which allocated an entries array and
 * re-checked `Array.isArray` on every property.
 */
function copyValue(value: unknown, seen?: Map<object, unknown>): unknown {
  if (Array.isArray(value)) {
    // Lazily create the cycle-tracking map only when the first container is
    // reached, so primitives keep the zero-allocation fast path.
    const map = (seen ??= new Map<object, unknown>());
    const cached = map.get(value);
    if (cached !== undefined) return cached;
    const copy: unknown[] = [];
    map.set(value, copy);
    for (const v of value) copy.push(copyValue(v, map));
    return copy;
  }
  if (value !== null && typeof value === "object") {
    const map = (seen ??= new Map<object, unknown>());
    const cached = map.get(value);
    if (cached !== undefined) return cached;
    const copy = Object.assign({} as Record<string, unknown>, value);
    map.set(value, copy);
    for (const k in copy) {
      copy[k] = copyValue(copy[k], map);
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
  /**
   * A shared read/write lock used by `withRWLock`/`withReadLock`/`withWriteLock`
   * on the returned wrapper. When provided (and shared across workers),
   * `withReadLock` allows many concurrent readers; otherwise these methods
   * fall back to the shared mutex.
   */
  rwLock?: RWLock;
}

type Loader<T> = () => T | Promise<T>;

const registry = new Map<string, SharedRef<unknown>>();

/**
 * Maps each SharedRef wrapper object to its shared key. Used by `encodeValue`
 * to embed a nested `Shared` object as a live reference (TYPE_KEY_REF) so
 * changes stay in sync, instead of copying or recursing into it (which would
 * loop forever on self/mutual references).
 */
const sharedKeyMap = new WeakMap<object, string>();

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
    options.rwLock,
  );
  registry.set(key, ref as SharedRef<unknown>);

  if (typeof initialOrLoader === "function") {
    return Promise.resolve((initialOrLoader as Loader<T>)()).then((value) => {
      registerInitial(mem, key, ref, value);
      return ref;
    });
  }

  registerInitial(mem, key, ref, initialOrLoader as T);
  return ref;
}

/**
 * Register a key's initial value exactly once, serialized across workers.
 *
 * When several workers call `Shared` for the same key concurrently, the
 * raw existence check is not atomic: two workers can both see the key as
 * absent and both insert it, producing two index-table entries for the same
 * key (each with its own data offset and version cell). Reads and writes then
 * resolve to different entries and updates become invisible across workers.
 *
 * Holding the shared lock while checking existence and writing the initial
 * value makes registration atomic: only the first worker inserts, and every
 * other worker observes the already-created key and preserves its value.
 */
function registerInitial(
  mem: SharedMemory,
  key: string,
  ref: { write(value: unknown): void },
  value: unknown,
): void {
  mem.withLock(() => {
    // If the key already exists in shared memory (e.g. it was created by the
    // main thread or a racing worker), don't overwrite it with the initial
    // value.
    if (getOffset(mem, key) === null) {
      ref.write(value);
    }
  });
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
  // Inline the read-cache fast path (instead of calling readCachedValue, which
  // returns a polymorphic {hit,value} union and allocates an object on every
  // cache hit). Keeping this monomorphic lets the JIT optimize the hot read.
  const cached = readCache.get(key);
  const value =
    cached !== undefined &&
    cached.version === Atomics.load(mem.versionView, cached.cell)
      ? cached.value
      : readValue(mem, key);
  if (Array.isArray(value)) {
    return getTopLevelArrayMember(mem, key, value, prop, arrayCapacity);
  }
  const propValue = (value as Record<string | symbol, unknown>)[prop];
  if (Array.isArray(propValue)) {
    return createArrayProxy(
      mem,
      { key, path: [{ kind: "prop", name: prop as string }] },
      arrayCapacity,
    );
  }
  if (propValue !== null && typeof propValue === "object") {
    return createNestedObjectProxy(
      mem,
      { key, path: [{ kind: "prop", name: prop as string }] },
      arrayCapacity,
    );
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
  if (slot.type === TYPE_OBJECT_REF || slot.type === TYPE_KEY_REF) {
    // Nested object (plain block or live shared reference): return a live
    // proxy so in-place mutation stays in sync.
    const value = createNestedObjectProxy(
      mem,
      { key, path: [{ kind: "prop", name: prop }] },
      arrayCapacity,
    );
    fieldCache.version = version;
    fieldCache.value = value;
    return value;
  }
  let value = decodeValue(mem, slot);
  if (Array.isArray(value)) {
    value = createArrayProxy(
      mem,
      { key, path: [{ kind: "prop", name: prop }] },
      arrayCapacity,
    );
  }
  fieldCache.version = version;
  fieldCache.value = value;
  return value;
}

/**
 * Write a single object-property slot whose offset is already resolved
 * (cached by the caller, e.g. the accessor setter). Avoids the
 * `getObjectLayout` Map lookup + `properties.get` per write on the hot path.
 */
function writeObjectSlot(
  mem: SharedMemory,
  key: string,
  slotOffset: number,
  val: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  if (typeof val === "number") {
    // Fast path: numbers need no old-slot read (freeSlotRefs is a no-op)
    // and no in-place string reuse; write the float64 directly.
    mem.updateNumberSlot(slotOffset, val);
    bumpTarget(mem, key, target);
    return;
  }
  if (typeof val === "boolean") {
    // Fast path: booleans need no old-slot read (freeSlotRefs is a no-op)
    // and no in-place string reuse; write the 4 Int32s directly.
    mem.updateBooleanSlot(slotOffset, val);
    bumpTarget(mem, key, target);
    return;
  }
  if (typeof val === "bigint" && val >= MIN_INT64 && val <= MAX_INT64) {
    // Fast path: int64 bigints are written directly, avoiding the ValueSlot
    // object allocation of the generic path.
    mem.updateBigIntSlot(slotOffset, val);
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
  // Serialize the write under the shared mutex (see `writeLock`).
  mem.withLock(() =>
    writePropInner(mem, key, prop, val, arrayCapacity, target),
  );
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
      writeObjectSlot(mem, key, slotOffset, val, arrayCapacity, target);
      return;
    }
  }

  // Top-level array index write: update only that array slot.
  // Within a lock-free write the layout version is stable, so we read it
  // once and reuse it for all checks below, saving 2 Atomics.load ops.
  const cachedLv = mem.getLayoutVersion();
  const offset = getCachedOffset(mem, key, target, cachedLv);
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
    if (ref === undefined || target!.__arrayRefLayoutVersion !== cachedLv) {
      ref = {
        offset: mem.dataTable.getInt32(offset + 4),
        count: mem.dataTable.getInt32(offset + 8),
        capacity: mem.dataTable.getInt32(offset + 12),
      };
      if (target !== undefined) {
        target.__arrayRef = ref;
        target.__arrayRefLayoutVersion = cachedLv;
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
    if (typeof val === "bigint" && val >= MIN_INT64 && val <= MAX_INT64) {
      // Fast path: int64 bigints are written directly, avoiding the
      // ValueSlot object allocation of the generic path.
      mem.updateArrayBigIntSlot(ref, index, val);
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
  rwLock?: RWLock,
): SharedRef<T> {
  const target = {
    key,
    mem,
    // Fast-path cache: mirrors the module-level readCache entry for this key
    // so the proxy get handler can read it without a Map lookup. Invalidated
    // on every local write/update; cross-worker invalidation is detected by
    // the version check in the get handler.
    __cache: undefined as
      | { version: number; value: unknown; index: number; cell: number }
      | undefined,
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
    withRWLock: <R>(fn: (self: SharedRef<T>) => R) => {
      if (rwLock)
        return rwLock.withWriteLock(() =>
          fn(target as unknown as SharedRef<T>),
        );
      return mem.withLock(() => fn(target as unknown as SharedRef<T>));
    },
    withWriteLock: <R>(fn: (self: SharedRef<T>) => R) => target.withRWLock(fn),
    withReadLock: <R>(fn: (self: SharedRef<T>) => R) => {
      if (rwLock)
        return rwLock.withReadLock(() => fn(target as unknown as SharedRef<T>));
      return mem.withLock(() => fn(target as unknown as SharedRef<T>));
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
    Object.defineProperty(proto, "withRWLock", {
      enumerable: false,
      configurable: false,
      value: target.withRWLock,
    });
    Object.defineProperty(proto, "withWriteLock", {
      enumerable: false,
      configurable: false,
      value: target.withWriteLock,
    });
    Object.defineProperty(proto, "withReadLock", {
      enumerable: false,
      configurable: false,
      value: target.withReadLock,
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
      // Cached object slot offset for this property so writes skip the
      // getObjectLayout Map lookup + properties.get on the hot path.
      // Invalidated when the layout version changes (defragmentation moves
      // the object block).
      let slotOffset: number | undefined;
      let slotLayoutVersion = -1;
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
          mem.withLock(() => {
            // Write directly to the cached slot offset when still valid,
            // skipping the getObjectLayout Map lookup + properties.get. The
            // layout version cannot change while the mutex is held (defrag
            // runs under the same lock), but the check keeps the read cache
            // resilient.
            if (slotLayoutVersion !== mem.getLayoutVersion()) {
              slotOffset = undefined;
              slotLayoutVersion = mem.getLayoutVersion();
            }
            if (slotOffset === undefined) {
              const layout = getObjectLayout(mem, key);
              if (layout === null) {
                // Not an object (shouldn't happen for an object accessor).
                throw new TypeError(
                  `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
                );
              }
              const so = layout.properties.get(name);
              if (so === undefined) {
                throw new TypeError(
                  `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
                );
              }
              slotOffset = so;
            }
            writeObjectSlot(mem, key, slotOffset, v, arrayCapacity, target);
          });
        },
      });
    }
    // Fixed shape: reject adding new properties (throws in strict mode).
    Object.preventExtensions(ref);
    sharedKeyMap.set(ref, key);
    return ref as unknown as SharedRef<T>;
  }

  // Arrays, primitives, or unknown shape: use a Proxy (index access, array
  // methods, and dynamic properties require interception).
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === "read") return t.read;
      if (prop === "write") return t.write;
      if (prop === "update") return t.update;
      if (prop === "withRWLock") return t.withRWLock;
      if (prop === "withWriteLock") return t.withWriteLock;
      if (prop === "withReadLock") return t.withReadLock;
      if (prop === "key") return t.key;
      if (prop === "buffer") return mem.dataTable.buffers[0];
      if (prop === Symbol.toPrimitive) return () => t.read();

      // push/pop on a top-level array: operate directly on the array ref
      // without decoding the whole array (O(1) amortized).
      if (prop === "push" || prop === "pop") {
        const resolved = resolveArrayRef(mem, { key, path: [] });
        if (resolved !== null) {
          return (...args: unknown[]) =>
            mutateArrayRef(mem, { key, path: [] }, prop, args);
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
  });
  sharedKeyMap.set(proxy, key);
  return proxy as unknown as SharedRef<T>;
}

/**
 * Return a live wrapper for a shared key that already exists (used to resolve
 * a TYPE_KEY_REF back to a reusable wrapper). Does not write anything — the
 * key must already exist in shared memory.
 */
function getNestedSharedRef<T = unknown>(
  mem: SharedMemory,
  key: string,
): SharedRef<T> {
  const existing = registry.get(key);
  if (existing) return existing as SharedRef<T>;
  const ref = createSharedRef<T>(mem, key, undefined) as SharedRef<T>;
  registry.set(key, ref as SharedRef<unknown>);
  return ref;
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
    __cache?: { version: number; value: unknown; index: number; cell: number };
  },
): unknown {
  // Inline the read-cache fast path (see readProp) to avoid the polymorphic
  // {hit,value} union returned by readCachedValue.
  const cached = readCache.get(key);
  if (
    cached !== undefined &&
    cached.version === Atomics.load(mem.versionView, cached.cell)
  ) {
    return cached.value;
  }

  const index = cached !== undefined ? cached.index : getIndex(mem, key);
  const cell =
    cached !== undefined ? cached.cell : mem.getVersionCellIndex(index);
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

  const entry = { version, value, index, cell };
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
  // Serialize the write under the shared mutex (see `writeLock`).
  mem.withLock(() => writeValueInner(mem, key, value, arrayCapacity, target));
}

function writeValueInner(
  mem: SharedMemory,
  key: string,
  value: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  // Within a lock-free write the layout version is stable (defragmentation
  // can only start when the write counter reaches 0), so we read it once
  // and reuse it for all checks below.
  const cachedLv = mem.getLayoutVersion();
  const existing = getCachedOffset(mem, key, target, cachedLv);
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
      } else if (value >= MIN_INT64 && value <= MAX_INT64) {
        // Fast path: int64 bigints are written directly, avoiding the
        // ValueSlot object allocation of the generic path.
        mem.updateBigIntSlot(existing, value);
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
      const oldC = mem.dataTable.getInt32(existing + 12);
      const ref = mem.storeStringValue(
        value,
        oldType === TYPE_STRING_VALUE_REF
          ? { offset: oldA, length: oldB, reserved: oldC || undefined }
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
/**
 * Resolve the array-ref slot for a locator, returning the current array-ref
 * ValueSlot and a `write` function that persists a new array-ref slot back to
 * its location (DataTable offset for a top-level array or object property,
 * ArrayTable slot for a nested array). Returns null if the value at the
 * locator is not an array.
 */
function resolveArrayRef(
  mem: SharedMemory,
  locator: ArrayLocator,
): { slot: ValueSlot; write: (s: ValueSlot) => void } | null {
  const { key, path } = locator;
  if (path.length === 0) {
    const offset = getOffset(mem, key);
    if (offset === null) return null;
    const slot = mem.readValueSlot(offset);
    if (slot.type !== TYPE_ARRAY_REF) return null;
    return { slot, write: (s) => mem.updateValueSlot(offset, s) };
  }
  const first = path[0]!;
  if (first.kind === "prop") {
    const layout = getObjectLayout(mem, key);
    if (layout === null) return null;
    const slotOffset = layout.properties.get(first.name);
    if (slotOffset === undefined) return null;
    const slot = mem.readValueSlot(slotOffset);
    if (slot.type !== TYPE_ARRAY_REF) return null;
    if (path.length === 1) {
      return { slot, write: (s) => mem.updateValueSlot(slotOffset, s) };
    }
    return resolveNestedArrayRef(mem, slot, path.slice(1));
  }
  // First step is an index: the root must be a top-level array.
  const rootOffset = getOffset(mem, key);
  if (rootOffset === null) return null;
  const rootSlot = mem.readValueSlot(rootOffset);
  if (rootSlot.type !== TYPE_ARRAY_REF) return null;
  return resolveNestedArrayRef(mem, rootSlot, path);
}

/**
 * Navigate into a nested array starting from a parent array-ref slot. `steps`
 * are all index steps. Returns the resolved array-ref slot and a writer, or
 * null if any step is not an array or is out of bounds.
 */
function resolveNestedArrayRef(
  mem: SharedMemory,
  parentSlot: ValueSlot,
  steps: ArrayStep[],
): { slot: ValueSlot; write: (s: ValueSlot) => void } | null {
  let ref: ArrayRef = {
    offset: parentSlot.a,
    count: parentSlot.b,
    capacity: parentSlot.c,
  };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind !== "index") return null;
    if (step.index >= ref.count) return null;
    const slot = mem.readArraySlot(ref, step.index);
    if (slot.type !== TYPE_ARRAY_REF) return null;
    if (i === steps.length - 1) {
      const slotRef = ref;
      const index = step.index;
      return { slot, write: (s) => mem.updateArraySlot(slotRef, index, s) };
    }
    ref = { offset: slot.a, count: slot.b, capacity: slot.c };
  }
  return null;
}

/**
 * O(1) in-place push/pop on a shared array ref, without decoding or
 * re-encoding the whole array. `locator` identifies the array (top-level,
 * object property, or nested).
 */
function mutateArrayRef(
  mem: SharedMemory,
  locator: ArrayLocator,
  method: "push" | "pop",
  args: unknown[],
): unknown {
  return writeLock(mem, () => {
    const resolved = resolveArrayRef(mem, locator);
    if (resolved === null) {
      throw new TypeError("Value is not an array");
    }
    const slot = resolved.slot;
    const ref: ArrayRef = {
      offset: slot.a,
      count: slot.b,
      capacity: slot.c,
    };

    if (method === "push") {
      for (const arg of args) {
        const next = mem.appendArraySlot(ref, encodeValue(mem, arg));
        // Always persist the new count (and offset/capacity if moved).
        resolved.write(arrayRefSlot(next));
        ref.offset = next.offset;
        ref.count = next.count;
        ref.capacity = next.capacity;
      }
      bump(mem, locator.key);
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
    resolved.write(arrayRefSlot(next));
    bump(mem, locator.key);
    return result;
  });
}

/**
 * Read the decoded value of the array at a locator, using the read cache for
 * the root value and navigating the path. This is the fast read path (the
 * root read hits the version-checked cache), matching the pre-nested-array
 * performance for array-property reads.
 */
function readArrayValue(mem: SharedMemory, locator: ArrayLocator): unknown[] {
  const root = readValue(mem, locator.key);
  const arr = readPathValue(mem, locator, root);
  if (!Array.isArray(arr)) {
    throw new TypeError("Value is not an array");
  }
  return arr;
}

/**
 * Navigate a decoded root value (the whole top-level value) along a locator
 * path, returning the value at the end of the path. Used by the fallback
 * read-modify-write paths.
 */
function readPathValue(
  mem: SharedMemory,
  locator: ArrayLocator,
  rootValue: unknown,
): unknown {
  let current = rootValue;
  for (const step of locator.path) {
    if (step.kind === "prop") {
      current = (current as Record<string, unknown>)[step.name];
    } else {
      current = (current as unknown[])[step.index];
    }
  }
  return current;
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
    const index = Number(prop);
    const element = value[index];
    if (Array.isArray(element)) {
      return createArrayProxy(
        mem,
        { key, path: [{ kind: "index", index }] },
        arrayCapacity,
      );
    }
    if (element !== null && typeof element === "object") {
      return createNestedObjectProxy(
        mem,
        { key, path: [{ kind: "index", index }] },
        arrayCapacity,
      );
    }
    return element;
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
        return mutateArrayRef(mem, { key, path: [] }, methodName, args);
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

/**
 * Create a proxy for an array at a locator (a top-level array, an array
 * property of a shared object, or a nested array). Index access and mutating
 * methods work directly; nested array elements are returned as their own
 * proxy so they can be mutated in place.
 */
function createArrayProxy(
  mem: SharedMemory,
  locator: ArrayLocator,
  arrayCapacity?: number,
): unknown[] {
  const { key } = locator;
  // Cache the resolved array ref and the version-cell index so index writes
  // skip the per-write path navigation and Map lookups. Invalidated when the
  // layout version changes (defragmentation or array growth via moveArray).
  let cachedRef:
    { offset: number; count: number; capacity: number } | undefined;
  let cachedLayoutVersion = -1;
  // Cached version-cell index for this key, so writes can bump the version
  // cell without a Map lookup on every write. Stable for the key's lifetime.
  let cachedIndex: number | undefined;

  /** Bump the key's version cell using the cached index (resolved lazily). */
  function bumpCached(): void {
    if (cachedIndex === undefined) {
      cachedIndex = getIndex(mem, key);
    }
    mem.bumpVersion(cachedIndex);
  }

  /**
   * Resolve the array ref, refreshing the cache when the layout changed or
   * when the cached count is too small for a requested index (the array may
   * have grown in place via `push` without a layout-version bump).
   */
  function getRef(minCount = 0): {
    offset: number;
    count: number;
    capacity: number;
  } {
    if (cachedLayoutVersion !== mem.getLayoutVersion()) {
      cachedRef = undefined;
      cachedLayoutVersion = mem.getLayoutVersion();
    }
    if (cachedRef !== undefined && cachedRef.count >= minCount)
      return cachedRef;
    const resolved = resolveArrayRef(mem, locator);
    if (resolved === null) {
      throw new TypeError("Value is not an array");
    }
    cachedRef = {
      offset: resolved.slot.a,
      count: resolved.slot.b,
      capacity: resolved.slot.c,
    };
    return cachedRef;
  }

  /**
   * Write a single array slot in place. Defined once (not per call) so the
   * set handler can inline the writeLock without allocating a closure on
   * every write.
   */
  function writeArrayProp(arrProp: string | symbol, val: unknown): boolean {
    if (typeof arrProp === "string" && /^\d+$/.test(arrProp)) {
      const index = Number(arrProp);
      const ref = getRef(index + 1);
      if (index >= ref.count) {
        throw new RangeError(
          `Index ${index} out of bounds for array of length ${ref.count}`,
        );
      }
      if (typeof val === "number") {
        // Fast path: numbers need no old-slot read (freeSlotRefs is a no-op).
        mem.updateArrayNumberSlot(ref, index, val);
        bumpCached();
        return true;
      }
      if (typeof val === "boolean") {
        // Fast path: booleans need no old-slot read (freeSlotRefs is a no-op).
        mem.updateArrayBooleanSlot(ref, index, val);
        bumpCached();
        return true;
      }
      if (typeof val === "bigint" && val >= MIN_INT64 && val <= MAX_INT64) {
        // Fast path: int64 bigints are written directly, avoiding the
        // ValueSlot object allocation of the generic path.
        mem.updateArrayBigIntSlot(ref, index, val);
        bumpCached();
        return true;
      }
      if (typeof val === "string") {
        // Fast path: short strings are written inline into the slot.
        if (mem.updateArrayInlineStringSlot(ref, index, val)) {
          bumpCached();
          return true;
        }
      }
      freeSlotRefs(mem, mem.readArraySlot(ref, index));
      mem.updateArraySlot(ref, index, encodeValue(mem, val, arrayCapacity));
      bumpCached();
      return true;
    }
    // Array length write: shrink/grow in place without re-encoding the whole
    // value (which would leave a dead slot).
    if (arrProp === "length") {
      const newLen = Number(val);
      if (!Number.isInteger(newLen) || newLen < 0) {
        throw new RangeError("Invalid array length");
      }
      const ref = getRef();
      if (newLen <= ref.capacity) {
        const resolved = resolveArrayRef(mem, locator);
        if (resolved === null) {
          throw new TypeError("Value is not an array");
        }
        resolved.write(
          arrayRefSlot({
            offset: ref.offset,
            count: newLen,
            capacity: ref.capacity,
          }),
        );
        cachedRef = {
          offset: ref.offset,
          count: newLen,
          capacity: ref.capacity,
        };
        bumpCached();
        return true;
      }
      // Growing beyond capacity falls through to the full read-modify-write.
    }
    // Fallback: full read-modify-write.
    return mutateValue<unknown[], boolean>(
      mem,
      key,
      (fresh) => {
        const arr = readPathValue(mem, locator, fresh) as unknown[];
        (arr as unknown as Record<string | symbol, unknown>)[arrProp] = val;
        return true;
      },
      arrayCapacity,
    );
  }

  return new Proxy([] as unknown[], {
    get(_target, arrProp) {
      // push/pop on the array: operate directly on the array ref without
      // decoding the whole value (O(1) amortized).
      if (arrProp === "push" || arrProp === "pop") {
        const resolved = resolveArrayRef(mem, locator);
        if (resolved !== null) {
          return (...args: unknown[]) =>
            mutateArrayRef(mem, locator, arrProp, args);
        }
      }
      if (arrProp === "length") {
        // Use the read cache (version-checked), so an in-place `push` that
        // grew the array is reflected (the version bump invalidates the cache).
        return readArrayValue(mem, locator).length;
      }
      if (typeof arrProp === "string" && /^\d+$/.test(arrProp)) {
        const index = Number(arrProp);
        const element = readArrayValue(mem, locator)[index];
        if (Array.isArray(element)) {
          return createArrayProxy(
            mem,
            { key, path: [...locator.path, { kind: "index", index }] },
            arrayCapacity,
          );
        }
        if (element !== null && typeof element === "object") {
          return createNestedObjectProxy(
            mem,
            { key, path: [...locator.path, { kind: "index", index }] },
            arrayCapacity,
          );
        }
        return element;
      }
      if (typeof arrProp === "symbol") {
        const arr = readArrayValue(mem, locator);
        if (arrProp === Symbol.iterator) return arr[Symbol.iterator].bind(arr);
        return (arr as unknown as Record<symbol, unknown>)[arrProp];
      }
      if (MUTATING_METHODS.has(arrProp)) {
        const methodName = arrProp;
        // push/pop are O(1) in-place operations on the array ref.
        if (methodName === "push" || methodName === "pop") {
          return (...args: unknown[]) => {
            return mutateArrayRef(mem, locator, methodName, args);
          };
        }
        return (...args: unknown[]) => {
          return mutateValue<unknown[], unknown>(
            mem,
            key,
            (fresh) => {
              const freshArr = readPathValue(mem, locator, fresh) as unknown[];
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
      const arr = readArrayValue(mem, locator);
      const method = (arr as unknown as Record<string, unknown>)[arrProp];
      if (typeof method === "function") return method.bind(arr);
      return method;
    },
    set(_target, arrProp, val) {
      // In-place update: write only the affected array slot instead of
      // decoding and re-encoding the whole value. Serialize under the shared
      // mutex (see `writeLock`).
      return mem.withLock(() => writeArrayProp(arrProp, val));
    },
  });
}
