import {
  LockTimeoutError,
  deadlineFor,
  getDefaultLockTimeout,
  waitSliceUntil,
} from "./wait.ts";
import {
  SharedMemory,
  TYPE_ARRAY_REF,
  TYPE_BIGINT_STR,
  TYPE_INLINE_STRING,
  TYPE_KEY_REF,
  TYPE_OBJECT_REF,
  TYPE_STRING_REF,
  TYPE_STRING_VALUE_REF,
  READLOCK_BIT,
  VERSION_LOCK_MASK,
  VERSION_LOCK_SHIFT_BITS,
  VERSION_STEP,
  WRITER_BIT,
  arrayRefSlot,
  bigintSlot,
  bigintStrSlot,
  booleanSlot,
  decodeSlot,
  keyRefSlot,
  nullSlot,
  numberSlot,
  objectRefSlot,
  stringValueRefSlot,
  type ArrayRef,
  type ObjectLayout,
  type ValueSlot,
  NOT_PRIMITIVE,
  onMemoryDisposed,
  readCellDepths,
  writeCellDepths,
} from "./memory.ts";
import { getDefaultMemory } from "./worker.ts";

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
 * The proxies a proxy has handed out for its nested arrays and plain objects,
 * by property name or index, so `o.p.r` and `grid[0]` are made once instead of
 * on every access (and stay identical: `grid[0] === grid[0]`). A child proxy
 * reads live data through its locator; the caller hands one out only after
 * checking that the current value at that place is of the same kind.
 */
interface ChildProxies {
  arrays: Map<string | number, unknown>;
  objects: Map<string | number, unknown>;
}

/** Child proxies remembered per proxy and kind (see `childProxy`). */
const MAX_CHILD_PROXIES = 256;

/** The path of a top-level value (shared, never modified). */
const NO_PATH: ArrayStep[] = [];

function newChildProxies(): ChildProxies {
  return { arrays: new Map(), objects: new Map() };
}

/** Child proxies of each key's top-level value (dropped with the key's caches). */
const topLevelChildCache = new Map<string, ChildProxies>();

function topLevelChildren(key: string): ChildProxies {
  let children = topLevelChildCache.get(key);
  if (children === undefined) {
    children = newChildProxies();
    topLevelChildCache.set(key, children);
  }
  return children;
}

function childProxy(
  children: ChildProxies,
  mem: SharedMemory,
  key: string,
  path: ArrayStep[],
  step: "prop" | "index",
  id: string | number,
  isArray: boolean,
  arrayCapacity: number | undefined,
): unknown {
  const map = isArray ? children.arrays : children.objects;
  const known = map.get(id);
  if (known !== undefined) return known;
  const child: ArrayLocator = {
    key,
    path: [
      ...path,
      step === "prop"
        ? { kind: "prop", name: id as string }
        : { kind: "index", index: id as number },
    ],
  };
  const made = isArray
    ? createArrayProxy(mem, child, arrayCapacity)
    : createNestedObjectProxy(mem, child, arrayCapacity);
  // `createNestedObjectProxy` hands out a live shared reference when the
  // place holds one by now: that is not this place's object proxy.
  if (made !== null && !sharedKeyMap.has(made)) {
    // Bounded: walking a large array of objects once must not keep a proxy
    // (with its caches) per element alive. Identity holds for recently used
    // places; an evicted one gets a new, equally valid proxy.
    if (map.size >= MAX_CHILD_PROXIES) map.clear();
    map.set(id, made);
  }
  return made;
}

/**
 * Run a write operation under the lock stripe of `key`. Writers to the same
 * value are serialized, so concurrent writers cannot lose updates or
 * interleave a multi-step write, while writers to different keys run in
 * parallel. The lock is re-entrant, so a write that internally calls another
 * write (e.g. `updateValue`) does not deadlock. Holding the stripe also
 * protects the write from a defragmentation pass, which takes every stripe.
 *
 * `target` (the proxy target) supplies the cached key index when available,
 * avoiding a Map lookup on the write hot path.
 *
 * Note: code holding a stripe (an `update()` callback, for example) that
 * writes to a *different* key takes that key's stripe too; two threads doing
 * so in opposite order can deadlock and fail with a `LockTimeoutError`.
 * The same holds when that other key is held by another thread's
 * `withReadLock`/`withWriteLock` whose callback reads past its cache: an
 * ordinary write waits for such a lock without holding the stripe, but a
 * stripe this thread already held before (here: the outer write's) stays held.
 */
function writeLock<T>(
  mem: SharedMemory,
  key: string,
  fn: () => T,
  target?: WriteTarget,
): T {
  // Key creation (and other global-mutex sections) writes a key that has no
  // Index Table entry yet: nothing else can touch it, and the global mutex
  // already excludes maintenance.
  // Fast path: if global lock held, skip stripe lock and index lookup.
  if (mem.holdsGlobalLock) return fn();
  let index = target?.__index;
  if (index === undefined) {
    index = getIndex(mem, key);
    if (target !== undefined) target.__index = index;
  }
  return mem.withKeyWrite(index, fn);
}

/**
 * Reject objects that are not plain data (Date, Map, Set, RegExp, typed
 * arrays, Error, Promise, ...). Their state lives in internal slots, so
 * `Object.entries` would see `{}` and the value would be stored as an empty
 * object, silently losing its contents. Class instances with own data
 * properties are still accepted and stored as plain objects.
 */
function assertPlainObject(value: object): void {
  const tag = Object.prototype.toString.call(value);
  if (tag !== "[object Object]") {
    throw new TypeError(
      `Cannot store ${tag.slice(8, -1)}: only primitives, bigints, arrays and plain objects are allowed (convert it first, e.g. Date -> number, Map -> Object.fromEntries)`,
    );
  }
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
    case "string": {
      // Short strings are stored inline in the slot (no heap block, and no
      // TextDecoder call when read back).
      const inline = mem.inlineStringSlot(value);
      if (inline !== null) return inline;
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
    }
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
        // A plain loop (not `map`) so holes in a sparse array are visited and
        // rejected with a clear error instead of corrupting the slot list.
        const slots: ValueSlot[] = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) {
            throw new TypeError(
              `Cannot store sparse array: index ${i} is a hole (use null or a value)`,
            );
          }
          slots[i] = encodeValue(
            mem,
            value[i],
            arrayCapacity,
            undefined,
            visited,
          );
        }
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
        assertPlainObject(value as object);
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
       * Run `fn` while holding a read lock on this value's version cell. While
       * held, other read/write operations on this object wait; reentrant reads
       * from within a write lock are allowed.
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
       * Run `fn` while holding a read lock on this value's version cell. While
       * held, other read/write operations on this object wait; reentrant reads
       * from within a write lock are allowed.
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
  {
    version: number;
    /** The version cell's raw value for `version` (lock bits clear): a hit is `cell === raw`. */
    raw: number;
    value: unknown;
    index: number;
    cell: number;
    /** Version at which a single array element was read without caching. */
    ev: number;
  }
>();

// ---------------------------------------------------------------------------
// Version-cell based seqlock (the object's version cell doubles as a lock).
//
// The low bits of the version cell are the lock state, the high bits the
// version (see VERSION_LOCK_MASK / WRITER_BIT / READLOCK_BIT). `withReadLock`
// and `withWriteLock` set/clear those bits; a plain read performs one load and
// waits whenever the lock bits are set. Because a worker is single-threaded,
// a lock is only held across a synchronous call stack, so reentrancy is
// tracked with simple depth maps keyed by the version-cell index.
// ---------------------------------------------------------------------------

function bumpCellDepth(map: Map<number, number>, cell: number): void {
  const d = map.get(cell);
  map.set(cell, d === undefined ? 1 : d + 1);
}
function dropCellDepth(map: Map<number, number>, cell: number): void {
  const d = map.get(cell)!;
  if (d === 1) map.delete(cell);
  else map.set(cell, d - 1);
}

/**
 * Wait until the version cell @ `cell` is not locked (no READLOCK/WRITER set)
 * across all workers, then return the object's version. Never blocks the
 * calling worker when it itself holds the lock (read-inside-write), since a
 * shared object may legitimately be read from within a lock block; in that
 * case the version is read directly.
 */
function waitForVersionCell(mem: SharedMemory, cell: number): number {
  return stableRaw(mem, cell) >> VERSION_LOCK_SHIFT_BITS;
}

/**
 * The raw version cell once no other thread holds a lock bit on it: the value
 * a lock-free read starts from and later validates against (see `getter` of an
 * object accessor). Bits this thread set itself (it is writing, or holds a
 * user-level lock) are returned as they are. An ordinary write holds the bit
 * for a few instructions, so wait by spinning first, then in short slices (such
 * a writer does not call `Atomics.notify`; a user-level lock does).
 */
function stableRaw(mem: SharedMemory, cell: number): number {
  let raw = Atomics.load(mem.versionView, cell);
  if ((raw & VERSION_LOCK_MASK) === 0) return raw;
  if (mem.holdsCell(cell)) return raw;
  for (let i = 0; i < 200; i++) {
    raw = Atomics.load(mem.versionView, cell);
    if ((raw & VERSION_LOCK_MASK) === 0) return raw;
  }
  const timeoutMs = getDefaultLockTimeout();
  const deadline = deadlineFor(timeoutMs);
  do {
    if (waitSliceUntil(mem.versionView, cell, raw, deadline) === "timed-out") {
      throw new LockTimeoutError("object lock", timeoutMs);
    }
    raw = Atomics.load(mem.versionView, cell);
  } while ((raw & VERSION_LOCK_MASK) !== 0);
  return raw;
}

/**
 * Acquire a lock bit on `cell`, spinning/waiting until it is free (or the
 * calling worker already holds it, i.e. reentrant). Returns false when the
 * current worker already holds the lock (caller must skip the free step).
 */
function acquireCellLock(
  mem: SharedMemory,
  cell: number,
  bit: number,
  depths: Map<number, number>,
): boolean {
  if (depths.has(cell)) {
    bumpCellDepth(depths, cell);
    return false;
  }
  // This thread is itself in the middle of an ordinary write of the object
  // (the lock is requested from inside `update()` for example): nothing to
  // acquire, and waiting for the bit would wait for ourselves.
  if (mem.isWritingCell(cell)) return false;
  let raw = Atomics.load(mem.versionView, cell);
  const timeoutMs = getDefaultLockTimeout();
  const deadline = deadlineFor(timeoutMs);
  for (;;) {
    if ((raw & VERSION_LOCK_MASK) !== 0) {
      // Sliced waits: an ordinary write clears its bit without a wake-up.
      if (
        waitSliceUntil(mem.versionView, cell, raw, deadline) === "timed-out"
      ) {
        throw new LockTimeoutError("object lock", timeoutMs);
      }
      raw = Atomics.load(mem.versionView, cell);
      continue;
    }
    const next = raw | bit;
    const taken = Atomics.compareExchange(mem.versionView, cell, raw, next);
    if (taken === raw) {
      bumpCellDepth(depths, cell);
      return true;
    }
    raw = taken;
  }
}

/**
 * Release a lock bit that was freshly acquired (reentrant releases are no-ops
 * at this layer; the outermost release clears the bit). Version and lock live
 * in the same cell, so releasing is a single atomic operation: clearing the
 * WRITER bit also bumps the version (readers that waited see the bump), while
 * clearing the READLOCK bit leaves the version untouched (a read changes
 * nothing).
 */
function releaseCellLock(
  mem: SharedMemory,
  cell: number,
  bit: number,
  depths: Map<number, number>,
): void {
  dropCellDepth(depths, cell);
  if (depths.has(cell)) return; // still held reentrantly
  // WRITER: version+1 and clear bit 0x1 in one add ((v<<2)|1 + 3 = (v+1)<<2).
  // READLOCK: clear bit 0x2 only (add -2 leaves the version unchanged).
  const delta = bit === WRITER_BIT ? VERSION_STEP - WRITER_BIT : -READLOCK_BIT;
  Atomics.add(mem.versionView, cell, delta);
  // Wake any workers parked in `Atomics.wait` (acquireCellLock/waitForVersionCell):
  // a bare value change does not wake a sleeping waiter, only `notify` does.
  Atomics.notify(mem.versionView, cell);
}

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
 * `__arrayRef` is only a holder of the three header fields (so a write
 * allocates nothing): a whole-value write stores a new array block and
 * push/pop/`length` change the count in place, in this or another worker,
 * neither of which bumps the layout version. The writers therefore refresh it
 * from the array-ref slot (`SharedMemory.refreshArrayRef`) under the lock.
 */
interface WriteTarget {
  __offset?: number;
  __layoutVersion: number;
  __type?: number;
  __arrayRef?: { offset: number; count: number; capacity: number } | undefined;
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

/**
 * Get (and cache) the stable layout of an object value, or null if not an
 * object. `layoutVersion` may be passed when the caller already holds the
 * key's stripe (or the global mutex) and has read the version without
 * atomics; otherwise it is read with an `Atomics.load`.
 */
function getObjectLayout(
  mem: SharedMemory,
  key: string,
  layoutVersion?: number,
): ObjectLayout | null {
  const version = layoutVersion ?? mem.getLayoutVersion();
  const cached = layoutCache.get(key);
  if (cached !== undefined && cached.version === version) {
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
  // Under the key's lock: the walk reads table bytes, which a concurrent
  // defragmentation could be moving (made once per place, so the lock is
  // cheap; it is re-entrant when the caller already holds it).
  const anchor = mem.withKeyLock(getIndex(mem, locator.key), () =>
    resolveNestedObject(mem, locator),
  );
  if (anchor === null) return null;
  if (anchor.kind === "shared") {
    return getNestedSharedRef(mem, anchor.key) as Record<
      string | symbol,
      unknown
    >;
  }

  // The pending write (see `set`) and the layout of the block last written:
  // valid for that block offset at that layout version, since a block's layout
  // never changes, a replaced sub-object gets a new block, and only a
  // defragmentation (which bumps the layout version) reuses offsets.
  const children = newChildProxies();
  let setProp: string | symbol = "";
  let setVal: unknown;
  // A path of property names only (`o.p`, `o.p.r`) is followed with the
  // cached layouts (`nestedLayoutAt`) and two slot reads per step; one through an array index
  // takes the general `resolveAnchorOffset`.
  const propPath = locator.path.every((step) => step.kind === "prop")
    ? locator.path.map((step) => (step as { name: string }).name)
    : null;
  /** DataTable offset of this proxy's object block; call under the key's lock. */
  const blockOffset = (): number | null => {
    if (propPath === null) return resolveAnchorOffset(mem, locator);
    let offset = getOffset(mem, locator.key);
    if (
      offset === null ||
      mem.dataTable.getInt32(offset) !== 5 /* TYPE_OBJECT */
    ) {
      return null;
    }
    for (const name of propPath) {
      const slotOffset = nestedLayoutAt(mem, offset)?.properties.get(name);
      if (slotOffset === undefined) return null;
      if (mem.dataTable.getInt32(slotOffset) !== TYPE_OBJECT_REF) return null;
      offset = mem.dataTable.getInt32(slotOffset + 4);
    }
    return offset;
  };
  const setBody = (): void => {
    const offset = blockOffset();
    if (offset === null) {
      throw new TypeError("Value is not an object");
    }
    const layout = nestedLayoutAt(mem, offset);
    if (layout === null) {
      throw new TypeError("Value is not an object");
    }
    const slotOffset = layout.properties.get(setProp as string);
    if (slotOffset === undefined) {
      throw new TypeError(
        `Nested object has a fixed shape: properties may not be added or removed`,
      );
    }
    writeObjectSlot(mem, locator.key, slotOffset, setVal, arrayCapacity);
  };

  // Per-property read cache of this proxy: value and the key version it was
  // read at. Filled under the key's lock by `readFieldBody`.
  let cell = -1;
  // Entries hold the version cell's raw value they were read at (lock bits
  // clear), so a hit is one comparison with the cell.
  const fields = new Map<string, { raw: number; value: unknown }>();
  let fieldProp = "";
  const readFieldBody = (): unknown => {
    const prop = fieldProp;
    // No ordinary writer of the key runs while its stripe is held, so the
    // version read here belongs to the slot read below.
    const rawIn = Atomics.load(mem.versionView, cell);
    const offset = blockOffset();
    let value: unknown = undefined;
    if (offset !== null) {
      const slotOffset = nestedLayoutAt(mem, offset)?.properties.get(prop);
      if (slotOffset !== undefined) {
        const type = mem.dataTable.getInt32(slotOffset);
        if (type === TYPE_ARRAY_REF || type === TYPE_OBJECT_REF) {
          value = childProxy(
            children,
            mem,
            locator.key,
            locator.path,
            "prop",
            prop,
            type === TYPE_ARRAY_REF,
            arrayCapacity,
          );
        } else {
          const primitive = mem.readPrimitiveAt(slotOffset);
          value =
            primitive !== NOT_PRIMITIVE
              ? primitive
              : decodeValue(mem, mem.readValueSlot(slotOffset));
        }
      }
    }
    if ((rawIn & VERSION_LOCK_MASK) === 0) {
      const entry = fields.get(prop);
      if (entry === undefined) {
        // Bounded: any name asked for gets an entry (also names the object
        // does not have, such as `then` probed by `await`).
        if (fields.size >= MAX_CHILD_PROXIES) fields.clear();
        fields.set(prop, { raw: rawIn, value });
      } else {
        entry.raw = rawIn;
        entry.value = value;
      }
    }
    return value;
  };

  const proxy = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === "read") {
        return () => copyValue(readValueAtLocator(mem, locator));
      }
      if (prop === "key") return locator.key;
      if (prop === "buffer") return mem.dataTable.buffers[0];
      if (typeof prop !== "string") return undefined;
      // This proxy's per-property cache, valid while the key's version is
      // unchanged and no lock bit is set (the same check as everywhere). An
      // entry exists only after a miss, which resolved `cell` below.
      const hit = fields.get(prop);
      if (hit !== undefined && mem.versionView[cell] === hit.raw) {
        return hit.value;
      }
      if (cell < 0) {
        cell = mem.getVersionCellIndex(getIndex(mem, locator.key));
      }
      // Miss: read just this property's slot under the key's lock (not the
      // whole root value: decoding all of a large value for one property
      // after each write made such reads cost the whole value). Wait out a
      // user-level lock held elsewhere first, like `readValue`.
      stableRaw(mem, cell);
      const sProp = fieldProp;
      fieldProp = prop;
      try {
        return mem.withKeyLock(getIndex(mem, locator.key), readFieldBody);
      } finally {
        fieldProp = sProp;
      }
    },
    set(_t, prop, val) {
      // Under the key's write lock like every other write (stripe, WRITER
      // bit, version bump): readers see the value whole, and neither a
      // defragmentation nor another writer of the key can run between
      // resolving the slot and storing into it. The pending property and
      // value travel through variables, so a write allocates no closure.
      const sProp = setProp;
      const sVal = setVal;
      setProp = prop;
      setVal = val;
      try {
        writeLock(mem, locator.key, setBody);
      } finally {
        setProp = sProp;
        setVal = sVal;
      }
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
    // `slice` copies the primitives in one native call; only nested arrays and
    // objects need a copy of their own.
    const copy = value.slice();
    for (let i = 0; i < copy.length; i++) {
      const element = copy[i];
      if (element !== null && typeof element === "object") {
        copy[i] = copyValue(element, seen);
      }
    }
    return copy;
  }
  if (value !== null && typeof value === "object") {
    if (sharedKeyMap.has(value)) {
      // A live `Shared` reference: the only way a value can contain itself
      // (self/mutual references), so cycle tracking starts here. Plain decoded
      // values are trees, which keeps the common case (no references) free of
      // the tracking map and its allocations.
      const map = seen ?? new Map<object, unknown>();
      const cached = map.get(value);
      if (cached !== undefined) return cached;
      const copy = Object.assign({} as Record<string, unknown>, value);
      map.set(value, copy);
      for (const k in copy) {
        const v = copy[k];
        if (v !== null && typeof v === "object") copy[k] = copyValue(v, map);
      }
      return copy;
    }
    // `Object.assign` already copied the primitives; only nested arrays and
    // objects need a copy of their own.
    const copy = Object.assign({} as Record<string, unknown>, value);
    for (const k in copy) {
      const v = copy[k];
      if (v !== null && typeof v === "object") copy[k] = copyValue(v, seen);
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
   * Initial capacity (in elements) reserved for arrays when they are first
   * stored. Arrays are created with this many slots, so subsequent `push`
   * calls can append in place without growing/moving the array until the
   * capacity is exhausted. Defaults to the array's length.
   */
  arrayCapacity?: number;
  /**
   * NOTE: The read/write lock for `withReadLock`/`withWriteLock`/`withRWLock`
   * is now embedded in the object's own version cell (a seqlock), so no
   * separate shared lock instance is required. The standalone `RWLock` class
   * remains available for manual, worker-wide locking.
   */
}

type Loader<T> = () => T | Promise<T>;

/**
 * The wrapper of each key this thread uses, held weakly: a wrapper (and with
 * it its closures and per-key state, about 1-2 KB) is freed once the program no
 * longer holds the reference. `Shared(key)` hands out the live wrapper while
 * one exists, so references to one key stay identical for as long as anyone can
 * observe the difference.
 */
const registry = new Map<string, WeakRef<SharedRef<unknown>>>();

/**
 * When a wrapper is collected, drop the key's entries in the per-thread caches
 * as well. They are keyed by name and would otherwise grow with every key ever
 * touched; the read cache even holds the last decoded value of each.
 */
const reclaimKey =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<string>(dropKey)
    : null;

function dropKey(key: string): void {
  // A newer wrapper for the same key took over: its caches are in use.
  if (registry.get(key)?.deref() !== undefined) return;
  registry.delete(key);
  readCache.delete(key);
  indexCache.delete(key);
  offsetCache.delete(key);
  layoutCache.delete(key);
  topLevelChildCache.delete(key);
}

/** The live wrapper of `key`, if one exists. */
function liveRef(key: string): SharedRef<unknown> | undefined {
  return registry.get(key)?.deref();
}

function rememberRef(key: string, ref: SharedRef<unknown>): void {
  registry.set(key, new WeakRef(ref));
  reclaimKey?.register(ref as object, key);
}

/** Number of wrappers and cache entries this thread holds (for tests). */
export function sharedCacheStats(): {
  wrappers: number;
  readCache: number;
  indexCache: number;
} {
  return {
    wrappers: registry.size,
    readCache: readCache.size,
    indexCache: indexCache.size,
  };
}

/**
 * Maps each SharedRef wrapper object to its shared key. Used by `encodeValue`
 * to embed a nested `Shared` object as a live reference (TYPE_KEY_REF) so
 * changes stay in sync, instead of copying or recursing into it (which would
 * loop forever on self/mutual references).
 */
const sharedKeyMap = new WeakMap<object, string>();

// The per-thread caches are keyed by key name only, which is sound because a
// thread has exactly one SharedMemory. When it is disposed, drop them so the
// next memory never sees stale entries.
onMemoryDisposed(() => {
  readCache.clear();
  indexCache.clear();
  offsetCache.clear();
  layoutCache.clear();
  topLevelChildCache.clear();
  nestedLayouts.clear();
  nestedLayoutsVersion = -1;
  registry.clear();
  pendingLoads.clear();
});

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
  const isLoader = typeof initialOrLoader === "function";
  const existing = liveRef(key);
  if (existing) {
    // A loader overload promises a Promise, even when the wrapper is cached.
    return isLoader
      ? Promise.resolve(existing as SharedRef<T>)
      : (existing as SharedRef<T>);
  }

  const mem = options.memory ?? getDefaultMemory();

  if (isLoader) {
    // Concurrent calls in this thread share one load (the loader runs once).
    const pending = pendingLoads.get(key);
    if (pending) return pending as Promise<SharedRef<T>>;
    const load = loadShared<T>(
      mem,
      key,
      initialOrLoader as Loader<T>,
      options.arrayCapacity,
    ).finally(() => pendingLoads.delete(key));
    pendingLoads.set(key, load as Promise<SharedRef<unknown>>);
    return load;
  }

  const ref = createSharedRef<T>(
    mem,
    key,
    initialOrLoader as T,
    options.arrayCapacity,
  );
  rememberRef(key, ref as SharedRef<unknown>);
  registerInitial(mem, key, ref, initialOrLoader as T);
  return ref;
}

/** In-flight `Shared(key, loader)` calls of this thread, by key. */
const pendingLoads = new Map<string, Promise<SharedRef<unknown>>>();

/**
 * Create a key from a loader. The loader only runs when the key does not exist
 * in shared memory yet. The wrapper is registered only after the value is
 * stored, so a failing loader leaves no half-created key behind and a later
 * call can retry.
 */
async function loadShared<T>(
  mem: SharedMemory,
  key: string,
  loader: Loader<T>,
  arrayCapacity: number | undefined,
): Promise<SharedRef<T>> {
  const exists = mem.withLock(() => getOffset(mem, key) !== null);
  const value = exists ? undefined : await loader();
  const ref = createSharedRef<T>(mem, key, value, arrayCapacity);
  if (!exists) registerInitial(mem, key, ref, value);
  rememberRef(key, ref as SharedRef<unknown>);
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
  ref: unknown,
  value: unknown,
): void {
  // Written through the target, not `ref.write`: through a proxy, that creates
  // the ref's `write` wrapper, and a ref that has one reads more slowly, even
  // if it never writes again (measured: `shared.read()` of a number 640 →
  // 775 M ops/s without it; the cause in the JIT is not known, wherever the
  // wrapper was kept, on the target, in a holder or in a WeakMap, made no
  // difference). So a ref that is only read keeps the fast reads, and a key
  // costs no wrapper closure until its first `write`.
  const target = (ref as Record<symbol, RefTarget>)[TARGET]!;
  // The budget may run out while creating the key; reclaim dead space (with no
  // lock held) and retry once rather than failing.
  mem.withReclaim(() =>
    mem.withLock(() => {
      // If the key already exists in shared memory (e.g. it was created by the
      // main thread or a racing worker), don't overwrite it with the initial
      // value.
      if (getOffset(mem, key) === null) {
        target.write(value);
      }
    }),
  );
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
  // The version cell doubles as a seqlock: a cache hit requires the lock bits
  // to be clear (no withReadLock/withWriteLock active) and the cached version
  // to match; otherwise we fall through to `readValue`, which waits out any
  // active lock before decoding.
  const cached = readCache.get(key);
  let value: unknown;
  // `cached.raw` has no lock bits: equal means unlocked and current.
  if (cached !== undefined && mem.versionView[cached.cell] === cached.raw) {
    value = cached.value;
  } else {
    // Miss (typically right after a write). A single element of an array need
    // not decode the whole array.
    const index = parseIndex(prop);
    if (index >= 0) {
      const element = tryReadElement(mem, key, null, index);
      if (element !== NOT_PRIMITIVE) return element;
    }
    value = readValue(mem, key);
  }
  if (Array.isArray(value)) {
    return getTopLevelArrayMember(mem, key, value, prop, arrayCapacity);
  }
  const propValue = (value as Record<string | symbol, unknown>)[prop];
  if (
    propValue !== null &&
    typeof propValue === "object" &&
    typeof prop === "string" &&
    Object.hasOwn(value as object, prop)
  ) {
    if (sharedKeyMap.has(propValue)) return propValue;
    return childProxy(
      topLevelChildren(key),
      mem,
      key,
      NO_PATH,
      "prop",
      prop,
      Array.isArray(propValue),
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
  fieldCache: { version: number; raw: number; value: unknown },
  version: number,
  arrayCapacity?: number,
  knownSlotOffset?: number,
): unknown {
  let slotOffset = knownSlotOffset;
  if (slotOffset === undefined) {
    const layout = getObjectLayout(mem, key);
    if (layout === null) {
      // Not an object (shouldn't happen for an object accessor); fall back.
      return readProp(mem, key, prop, arrayCapacity);
    }
    slotOffset = layout.properties.get(prop);
    if (slotOffset === undefined) {
      throw new TypeError(
        `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
      );
    }
  }
  // Allocation-free path for the common primitive slots.
  const primitive = mem.readPrimitiveAt(slotOffset);
  if (primitive !== NOT_PRIMITIVE) {
    fieldCache.version = version;
    fieldCache.raw = version << VERSION_LOCK_SHIFT_BITS;
    fieldCache.value = primitive;
    return primitive;
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
    fieldCache.raw = version << VERSION_LOCK_SHIFT_BITS;
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
  fieldCache.raw = version << VERSION_LOCK_SHIFT_BITS;
  fieldCache.value = value;
  return value;
}

/**
 * Write a single object-property slot whose offset is already resolved
 * (cached by the caller, e.g. the accessor setter). Avoids the
 * `getObjectLayout` Map lookup + `properties.get` per write on the hot path.
 */
/**
 * Write `val` into the object property slot at `slotOffset` (fast paths for
 * numbers, booleans, int64 bigints and inline strings, the general encode
 * otherwise) without bumping the version; callers bump once per write.
 */
function storeObjectSlot(
  mem: SharedMemory,
  slotOffset: number,
  val: unknown,
  arrayCapacity?: number,
): void {
  if (typeof val === "number") {
    // Fast path: numbers need no old-slot read (freeSlotRefs is a no-op)
    // and no in-place string reuse; write the float64 directly.
    mem.updateNumberSlot(slotOffset, val);
    return;
  }
  if (typeof val === "boolean") {
    // Fast path: booleans need no old-slot read (freeSlotRefs is a no-op)
    // and no in-place string reuse; write the 4 Int32s directly.
    mem.updateBooleanSlot(slotOffset, val);
    return;
  }
  if (typeof val === "bigint" && val >= MIN_INT64 && val <= MAX_INT64) {
    // Fast path: int64 bigints are written directly, avoiding the ValueSlot
    // object allocation of the generic path.
    mem.updateBigIntSlot(slotOffset, val);
    return;
  }
  if (typeof val === "string") {
    // Fast path: short strings are written inline into the slot itself.
    if (mem.updateInlineStringSlot(slotOffset, val)) {
      return;
    }
  }
  const oldSlot = mem.readValueSlot(slotOffset);
  freeSlotRefs(mem, oldSlot);
  mem.updateValueSlot(
    slotOffset,
    encodeValue(mem, val, arrayCapacity, oldSlot),
  );
}

function writeObjectSlot(
  mem: SharedMemory,
  key: string,
  slotOffset: number,
  val: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  storeObjectSlot(mem, slotOffset, val, arrayCapacity);
  bumpTarget(mem, key, target);
}

/**
 * Write a single property of a shared object value in place.
 *
 * Shared by the proxy `set` handler and the generated accessor setters. Uses
 * the cached layout to update only the affected slot.
 */
// State of the `writeProp` in progress. The lock body is a module-level
// function that reads it, so a write allocates no closure (the closure and its
// captured variables were a measurable part of an array index write). A write
// is synchronous; `writeProp` saves and restores the state so a write started
// from inside a write (for example by a getter of the value being encoded)
// cannot clobber the outer one.
let wpMem: SharedMemory;
let wpKey = "";
let wpProp: string | symbol = "";
let wpVal: unknown;
let wpCapacity: number | undefined;
let wpTarget: WriteTarget | undefined;

function writePropBody(): void {
  writePropInner(wpMem, wpKey, wpProp, wpVal, wpCapacity, wpTarget);
}

function writeProp(
  mem: SharedMemory,
  key: string,
  prop: string | symbol,
  val: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  const sMem = wpMem;
  const sKey = wpKey;
  const sProp = wpProp;
  const sVal = wpVal;
  const sCapacity = wpCapacity;
  const sTarget = wpTarget;
  wpMem = mem;
  wpKey = key;
  wpProp = prop;
  wpVal = val;
  wpCapacity = arrayCapacity;
  wpTarget = target;
  try {
    // Serialize the write under the key's lock stripe (see `writeLock`).
    writeLock(mem, key, writePropBody, target);
  } finally {
    wpMem = sMem;
    wpKey = sKey;
    wpProp = sProp;
    wpVal = sVal;
    wpCapacity = sCapacity;
    wpTarget = sTarget;
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
  // While we hold the key's stripe the layout version is stable, so we read it
  // once (plain read, no atomics) and reuse it for all checks below.
  const cachedLv = mem.layoutVersionInLock();

  // If the slot type is already cached on the target, we can skip the
  // getObjectLayout Map lookup for top-level arrays (which are never objects).
  const knownType = target?.__type;
  if (knownType !== TYPE_ARRAY_REF) {
    // Object property: use the cached layout to write only that slot.
    const layout = getObjectLayout(mem, key, cachedLv);
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
  const offset = getCachedOffset(mem, key, target, cachedLv);
  if (offset === null) {
    throw new Error(`No shared value found for key "${key}"`);
  }
  // The slot's type is read live: a whole-value write can turn an array into
  // a number (or back) without touching the cached `__type`, and treating a
  // number slot as an array ref wrote into a dead block or, for `length`,
  // replaced the number with an array assembled from its bits.
  const slotType = mem.slotTypeAt(offset);
  if (target !== undefined) target.__type = slotType;
  const parsedIndex = slotType === TYPE_ARRAY_REF ? parseIndex(prop) : -1;
  if (parsedIndex >= 0) {
    const index = parsedIndex;
    // The ArrayRef object is cached on the target, its fields are not.
    let ref = target?.__arrayRef;
    if (ref === undefined) {
      ref = { offset: 0, count: 0, capacity: 0 };
      if (target !== undefined) target.__arrayRef = ref;
    }
    // Refreshed on every write, see `WriteTarget`.
    mem.refreshArrayRef(ref, offset);
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

/** Hidden own property of every SharedRef: its `RefTarget`. */
const TARGET: unique symbol = Symbol("shared.target");

/**
 * Per-key state of a SharedRef: the write/read hot-path caches plus the
 * methods behind `read`/`write`/`update`/`with*Lock`. The methods live on the
 * class (one copy for all keys) instead of being closures created per key.
 */
class RefTarget<T = unknown> {
  /**
   * Fast-path cache: mirrors the module-level readCache entry for this key so
   * the proxy get handler can read it without a Map lookup. Invalidated on
   * every local write/update; cross-worker invalidation is detected by the
   * version check in the get handler.
   */
  __cache:
    | {
        version: number;
        raw: number;
        value: unknown;
        index: number;
        cell: number;
        ev: number;
      }
    | undefined = undefined;
  /**
   * Cached DataTable offset for this key, valid only while the global layout
   * version is unchanged (no defragmentation has moved it). Mirrors the
   * module-level offsetCache to avoid a Map lookup on the write hot path.
   */
  __offset: number | undefined = undefined;
  __layoutVersion = -1;
  /** Cached slot type, so the write hot path can skip the DataTable read. */
  __type: number | undefined = undefined;
  /**
   * Cached ArrayRef for a top-level array value, so index writes skip
   * re-reading the 3 header Int32s. Valid only while the global layout version
   * is unchanged and the array has not grown past the cached count.
   */
  __arrayRef: { offset: number; count: number; capacity: number } | undefined =
    undefined;
  /** Cached version-cell index (stable for the key's lifetime). */
  __index: number | undefined = undefined;
  /**
   * `read` as seen through a Proxy, created on first use. A shared method has
   * to find its target through a second trap call (`this[TARGET]`), which made
   * `ref.read()` on a primitive 2.5× slower; this one answers in a single
   * call. Only keys that are read through `read()` pay for the closure. (A
   * field each for `write`/`update` gained nothing and cost 128 B per key.)
   */
  __readFn: ((...args: never[]) => unknown) | undefined = undefined;
  /** `write` as seen through a Proxy, like `__readFn` (one trap call instead of two). */
  __writeFn: ((value: never) => void) | undefined = undefined;
  /**
   * The reference handed back to the caller (accessor object or proxy). Lock
   * callbacks receive it, not this target, so `self.prop = x` inside
   * `withWriteLock` writes to shared memory.
   */
  publicRef: unknown = undefined;

  constructor(
    readonly mem: SharedMemory,
    readonly key: string,
    readonly arrayCapacity: number | undefined,
  ) {}

  read(): T {
    const v = readValue(this.mem, this.key, this);
    // Primitives need no copy.
    return (typeof v === "object" && v !== null ? copyValue(v) : v) as T;
  }

  write(value: T): void {
    this.__cache = undefined;
    // Fast path for a number into a slot whose offset, type and index are
    // already cached: the same lock + version bump as `writeValue`, without its
    // global state and closure. Validated once the stripe is held (defrag takes
    // every stripe), and anything unusual (global section, nested write,
    // user-level lock, layout moved, object slot) takes the general path.
    if (typeof value === "number") {
      const index = this.__index;
      if (index !== undefined) {
        const mem = this.mem;
        const cell = mem.beginPlainWrite(index);
        if (cell >= 0) {
          let done = false;
          try {
            const offset = this.__offset;
            const type = this.__type;
            if (
              offset !== undefined &&
              type !== undefined &&
              type !== 5 &&
              this.__layoutVersion === mem.layoutVersionInLock()
            ) {
              mem.updateNumberSlot(offset, value);
              done = true;
            }
          } finally {
            mem.endPlainWrite(index, cell);
          }
          if (done) return;
        }
      }
    } else if (
      typeof value === "boolean" ||
      typeof value === "bigint" ||
      typeof value === "string"
    ) {
      if (this.writeSmallPrimitive(value)) return;
    }
    writeValue(this.mem, this.key, value, this.arrayCapacity, this);
  }

  /**
   * The same fast path as in `write` for a boolean, an int64 bigint or a string
   * that fits inline (11 UTF-8 bytes) into a slot with cached offset, type and
   * index. False when the value does not qualify or the cached state is not
   * usable: nothing has been stored then and the caller takes the general path.
   */
  private writeSmallPrimitive(value: boolean | bigint | string): boolean {
    const index = this.__index;
    if (index === undefined) return false;
    if (typeof value === "string") {
      if (value.length > 11) return false;
    } else if (typeof value === "bigint") {
      if (value < MIN_INT64 || value > MAX_INT64) return false;
    }
    const mem = this.mem;
    const cell = mem.beginPlainWrite(index);
    if (cell < 0) return false;
    let done = false;
    try {
      const offset = this.__offset;
      const type = this.__type;
      if (
        offset !== undefined &&
        type !== undefined &&
        type !== 5 &&
        this.__layoutVersion === mem.layoutVersionInLock()
      ) {
        if (typeof value === "boolean") {
          mem.updateBooleanSlot(offset, value);
          done = true;
        } else if (typeof value === "bigint") {
          mem.updateBigIntSlot(offset, value);
          done = true;
        } else {
          done = mem.updateInlineStringSlot(offset, value);
        }
      }
    } finally {
      mem.endPlainWrite(index, cell);
    }
    return done;
  }

  update(fn: (current: T) => T): T {
    this.__cache = undefined;
    return updateValue(this.mem, this.key, fn, this.arrayCapacity);
  }

  withRWLock<R>(fn: (self: SharedRef<T>) => R): R {
    // The object's version cell is the lock: acquire the WRITER bit (one CAS;
    // wait while any other worker holds read/write), run the callback, then
    // release in a single add that also bumps the version.
    const mem = this.mem;
    const cell = mem.getVersionCellIndex(getIndex(mem, this.key));
    const acquired = acquireCellLock(mem, cell, WRITER_BIT, writeCellDepths);
    try {
      return fn((this.publicRef ?? this) as SharedRef<T>);
    } finally {
      if (acquired) releaseCellLock(mem, cell, WRITER_BIT, writeCellDepths);
    }
  }

  withReadLock<R>(fn: (self: SharedRef<T>) => R): R {
    // Acquire the READLOCK bit so other readers/writers on this object wait,
    // run the callback, then release (version untouched).
    const mem = this.mem;
    const cell = mem.getVersionCellIndex(getIndex(mem, this.key));
    const acquired = acquireCellLock(mem, cell, READLOCK_BIT, readCellDepths);
    try {
      return fn((this.publicRef ?? this) as SharedRef<T>);
    } finally {
      if (acquired) releaseCellLock(mem, cell, READLOCK_BIT, readCellDepths);
    }
  }
}

/**
 * The public methods, shared by all refs. They find their key through the
 * hidden TARGET property of `this` (the object ref itself, or the proxy, whose
 * `get` trap answers TARGET).
 */
type TargetOf = { [TARGET]: RefTarget<any> };
const REF_METHODS = {
  read(this: TargetOf) {
    return this[TARGET].read();
  },
  write(this: TargetOf, value: unknown) {
    this[TARGET].write(value);
  },
  update(this: TargetOf, fn: (current: any) => any) {
    return this[TARGET].update(fn);
  },
  withRWLock(this: TargetOf, fn: (self: any) => unknown) {
    return this[TARGET].withRWLock(fn);
  },
  withWriteLock(this: TargetOf, fn: (self: any) => unknown) {
    return this[TARGET].withRWLock(fn);
  },
  withReadLock(this: TargetOf, fn: (self: any) => unknown) {
    return this[TARGET].withReadLock(fn);
  },
  toPrimitive(this: TargetOf) {
    return this[TARGET].read();
  },
};

/**
 * Prototype of all object refs. Methods are non-enumerable, so they don't
 * appear in JSON.stringify / Object.keys.
 */
const REF_PROTO: object = (() => {
  const proto: Record<string | symbol, unknown> = {
    [Symbol.toPrimitive]: REF_METHODS.toPrimitive,
  };
  for (const name of [
    "read",
    "write",
    "update",
    "withRWLock",
    "withWriteLock",
    "withReadLock",
  ] as const) {
    Object.defineProperty(proto, name, {
      enumerable: false,
      configurable: false,
      value: REF_METHODS[name],
    });
  }
  Object.defineProperty(proto, "key", {
    enumerable: false,
    configurable: false,
    get(this: TargetOf) {
      return this[TARGET].key;
    },
  });
  Object.defineProperty(proto, "buffer", {
    enumerable: false,
    configurable: false,
    get(this: TargetOf) {
      return this[TARGET].mem.dataTable.buffers[0];
    },
  });
  return proto;
})();

/** State of one accessor property of an object ref (one per key and property). */
interface PropState {
  t: RefTarget;
  name: string;
  /**
   * Version-cell index, resolved by the first `readPropMiss`; 0 until then
   * (the Index Table header, which the getter may read: it never equals
   * `raw`'s start value, so the first access always misses).
   */
  cell: number;
  cellResolved: boolean;
  /** Version and decoded value of the property cache (`readObjectProp` fills them). */
  version: number;
  /**
   * The version cell's raw value that `version` corresponds to (lock bits
   * clear), so the getter's hit test is one comparison. Starts as -1: both
   * lock bits set, a state a version cell never has (READLOCK and WRITER are
   * never set together), and not a key count either, so it never matches
   * before a value was read.
   */
  raw: number;
  value: unknown;
  /**
   * Stable proxies for an array property and a plain nested object property.
   * They read live data, so they survive writes, but are handed out only
   * while the slot still holds that kind of value (see `readPropMiss`).
   */
  arrayProxy: unknown[] | undefined;
  objectProxy: object | undefined;
  /** Cached slot offset, valid while `slotLayoutVersion` is the layout version. */
  slotOffset: number | undefined;
  slotLayoutVersion: number;
  /** Value of the write in progress, read by `writeBody`. */
  pending: unknown;
  writeBody: (() => void) | undefined;
}

/**
 * The property's slot offset, cached per accessor and re-resolved when the
 * global layout version `lv` changed (defragmentation or array growth moved
 * blocks). Shared by the getter's miss path and the setter.
 */
function resolveSlot(st: PropState, lv: number): number {
  if (st.slotLayoutVersion !== lv) {
    st.slotOffset = undefined;
    st.slotLayoutVersion = lv;
  }
  if (st.slotOffset === undefined) {
    const { mem, key } = st.t;
    const layout = getObjectLayout(mem, key);
    const so = layout?.properties.get(st.name);
    if (so === undefined) {
      // Not an object, or the property does not exist.
      throw new TypeError(
        `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
      );
    }
    st.slotOffset = so;
  }
  return st.slotOffset;
}

/*
 * Note on the plain-write fast paths (`RefTarget.writeSmallPrimitive`,
 * the accessor setter in `createSharedRef`, the `set` trap of
 * `REF_PROXY_HANDLER`, the `set` trap in `createArrayProxy`):
 * each checks and stores the value types itself, on purpose. Shared helpers
 * for the type check and the store collect JIT type feedback from all four
 * call sites, turn polymorphic over number/boolean/bigint/string, and made the
 * writes slower (measured: boolean write -20 %, string -14 %, bigint -6 %,
 * array index writes -5 %). Keep the copies in sync by hand.
 */

/** The setter's write callback; created on the first write of an accessor. */
function makeWriteBody(st: PropState): () => void {
  return () => {
    const t = st.t;
    // The layout version cannot change while the key's stripe is held
    // (defrag takes every stripe), so the plain read is enough here.
    writeObjectSlot(
      t.mem,
      t.key,
      resolveSlot(st, t.mem.layoutVersionInLock()),
      st.pending,
      t.arrayCapacity,
      t,
    );
  };
}

/**
 * The getter's miss path, kept out of the getter itself so the hot hit path
 * stays small enough for the JIT to inline.
 */
function readPropMiss(st: PropState): unknown {
  const { mem, key, arrayCapacity } = st.t;
  const name = st.name;
  if (!st.cellResolved) {
    st.cell = mem.getVersionCellIndex(getIndex(mem, key));
    st.cellResolved = true;
  }
  const cell = st.cell;
  // If this property is an array or a plain nested object, return the stable
  // cached proxy (which reads fresh data on each access) instead of making a
  // new one after every write. The proxy reads nothing here, so there is no
  // lock to wait for either: that wait made `o.arr[i] = v` pay for it after
  // every write. The slot's type tag decides whether the proxy still fits: a
  // write may have replaced the array or object with something else (the
  // array proxy used to be returned even after `o.arr = 5`).
  // The type tag is read without a lock, so it only counts while no
  // defragmentation moves data under it (settled, unchanged layout version).
  const lv0 = mem.getLayoutVersion();
  if (
    (st.arrayProxy !== undefined || st.objectProxy !== undefined) &&
    SharedMemory.layoutSettled(lv0)
  ) {
    const seen = mem.versionView[cell]!;
    let type = -1;
    try {
      type = mem.slotTypeAt(resolveSlot(st, lv0));
    } catch {
      // Unreadable layout: the general path below decides.
    }
    const proxy =
      type === TYPE_ARRAY_REF
        ? st.arrayProxy
        : type === TYPE_OBJECT_REF
          ? st.objectProxy
          : undefined;
    // The add(…, 0) is a full barrier: the reads above happen before it.
    const now = Atomics.add(mem.versionView, cell, 0);
    if (proxy !== undefined && mem.getLayoutVersion() === lv0) {
      // Remember it for this version when no write overlapped the type check,
      // so the next accesses take the getter's hit path again (otherwise every
      // access after a write came back here).
      if ((seen & VERSION_LOCK_MASK) === 0 && now === seen) {
        st.version = seen >> VERSION_LOCK_SHIFT_BITS;
        st.raw = seen;
        st.value = proxy;
      }
      return proxy;
    }
  }
  // Miss: wait until nobody is writing, then decode and validate.
  let raw = stableRaw(mem, cell);
  if (st.version === raw >> VERSION_LOCK_SHIFT_BITS) {
    return st.value;
  }
  // The slot is read without a lock, so a write that overlaps the read could
  // be seen half done (a string assembled from two writes). The version cell
  // is a seqlock: a writer holds its WRITER bit while it writes and bumps the
  // version when done, so if the cell is not exactly what it was before the
  // read, decode again. The validating add(…, 0) is a full barrier, keeping
  // the data reads before it. A defragmentation moves data without touching
  // the version cell, so the layout version is the second seqlock: it must be
  // settled (even) before and unchanged after (it was not, and a string read
  // while its bytes were moved came back as garbage).
  let value: unknown;
  for (let attempt = 0; ; attempt++) {
    const lv = mem.getLayoutVersion();
    if (attempt < 8 && SharedMemory.layoutSettled(lv)) {
      let readable = true;
      try {
        value = readObjectProp(
          mem,
          key,
          name,
          st,
          raw >> VERSION_LOCK_SHIFT_BITS,
          arrayCapacity,
          resolveSlot(st, lv),
        );
      } catch (error) {
        // Bytes read while a defragmentation began can look like anything,
        // a missing property included: only an error at an unchanged layout
        // and version is real.
        if (
          Atomics.add(mem.versionView, cell, 0) === raw &&
          mem.getLayoutVersion() === lv
        ) {
          throw error;
        }
        readable = false;
      }
      if (
        readable &&
        Atomics.add(mem.versionView, cell, 0) === raw &&
        mem.getLayoutVersion() === lv
      ) {
        break;
      }
      raw = stableRaw(mem, cell);
      continue;
    }
    {
      // Heavily written object, or a defragmentation in progress: read once
      // under the key's lock (which waits for the defragmentation, as that
      // holds every stripe).
      const keyIndex = getIndex(mem, key);
      raw = stableRaw(mem, cell);
      value = mem.withKeyLock(keyIndex, () =>
        readObjectProp(
          mem,
          key,
          name,
          st,
          raw >> VERSION_LOCK_SHIFT_BITS,
          arrayCapacity,
          resolveSlot(st, mem.getLayoutVersion()),
        ),
      );
      break;
    }
  }
  if (Array.isArray(value)) {
    st.arrayProxy = value;
  } else if (
    value !== null &&
    typeof value === "object" &&
    !sharedKeyMap.has(value)
  ) {
    // A plain nested object's proxy (a live shared reference is a wrapper of
    // its own and is not cached here).
    st.objectProxy = value;
  }
  return value;
}

/**
 * Proxy handler for array/primitive refs, shared by all keys (a handler object
 * with its own closures per key costs about a quarter of a kilobyte each).
 */
/**
 * `arr[i]` on a top-level array whose decoded value is in the read cache and
 * whose element is a primitive: answered before the method-name checks of the
 * `get` trap. `NOT_PRIMITIVE` sends everything else (a miss, a nested array or
 * object, a non-array value) down the general path, which gives the same
 * answer for these cases.
 */
function readIndexFast(t: RefTarget, prop: string, first: number): unknown {
  // The entry is remembered on the target, so a hit skips the Map lookup.
  let cached = t.__cache;
  if (cached === undefined || t.mem.versionView[cached.cell] !== cached.raw) {
    cached = readCache.get(t.key);
    if (cached === undefined) return NOT_PRIMITIVE;
    if (t.mem.versionView[cached.cell] !== cached.raw) return NOT_PRIMITIVE;
    t.__cache = cached;
  }
  const value = cached.value;
  if (!Array.isArray(value)) return NOT_PRIMITIVE;
  // `parseIndex` written out, from the second character on: the trap has
  // checked the first one and passes its digit (`first`). Measured, index
  // reads +39 % (`arr[3]`), +28 % (`arr[42]`), +26 % (`arr[123]`). Not
  // tried again: this hit path written out in the trap itself was slower
  // than this call (`arr[3]` 186 → 163 M ops/s).
  let index = first;
  for (let i = 1; i < prop.length; i++) {
    const digit = prop.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return NOT_PRIMITIVE;
    index = index * 10 + digit;
  }
  const element: unknown = value[index];
  if (element !== null && typeof element === "object") {
    // A nested array or object: its cached child proxy (a live shared
    // reference as it is), like `getTopLevelArrayMember` does.
    if (sharedKeyMap.has(element)) return element;
    return childProxy(
      topLevelChildren(t.key),
      t.mem,
      t.key,
      NO_PATH,
      "index",
      index,
      Array.isArray(element),
      t.arrayCapacity,
    );
  }
  return element;
}

const REF_PROXY_HANDLER: ProxyHandler<RefTarget> = {
  get(t, prop) {
    // Index reads first: they are the hot path of an array ref, and every
    // name check below would be paid on each of them.
    if (typeof prop === "string") {
      const digit = prop.charCodeAt(0) - 48;
      if (digit >= 0 && digit <= 9) {
        const element = readIndexFast(t, prop, digit);
        if (element !== NOT_PRIMITIVE) return element;
      }
    }
    // Every shared method (`this[TARGET]`) asks for this first.
    if (prop === TARGET) return t;
    if (prop === "read") {
      // Not tried again: checking `t.__cache` here before `readValue` (to skip
      // its Map lookup, as `readIndexFast` does) made primitive reads 31 %
      // slower, measured twice (number read 486 → 335 M ops/s).
      // The form of these wrappers matters to the JIT, measured: a bound
      // `read` made primitive reads 46 % slower than this arrow function.
      return (t.__readFn ??= () => {
        const v = readValue(t.mem, t.key, t);
        return typeof v === "object" && v !== null ? copyValue(v) : v;
      });
    }
    if (prop === "write") {
      // A plain function expression. Measured against the alternatives
      // (number write, M ops/s, `bun run bench` case / a loop of `o.write(i)`):
      // arrow `(v) => t.write(v)` 49.6 / 79; `t.write.bind(t)` 80 / 48 (the
      // loop shape, the common one, 40 % slower); `.call`/`.apply` 55 / 79;
      // this one 57 / 81.
      return (t.__writeFn ??= function (value: unknown) {
        // The number fast path of `RefTarget.write`, written out here: one
        // function level less (see the accessor setter in `createSharedRef`).
        if (typeof value === "number") {
          const index = t.__index;
          if (index !== undefined) {
            const mem = t.mem;
            const cell = mem.beginPlainWrite(index);
            if (cell >= 0) {
              let done = false;
              try {
                const offset = t.__offset;
                const type = t.__type;
                if (
                  offset !== undefined &&
                  type !== undefined &&
                  type !== 5 &&
                  t.__layoutVersion === mem.layoutVersionInLock()
                ) {
                  t.__cache = undefined;
                  mem.updateNumberSlot(offset, value);
                  done = true;
                }
              } finally {
                mem.endPlainWrite(index, cell);
              }
              if (done) return;
            }
          }
        }
        t.write(value);
      });
    }
    if (prop === "update") return REF_METHODS.update;
    if (prop === "withRWLock") return REF_METHODS.withRWLock;
    if (prop === "withWriteLock") return REF_METHODS.withWriteLock;
    if (prop === "withReadLock") return REF_METHODS.withReadLock;
    if (prop === "key") return t.key;
    if (prop === "buffer") return t.mem.dataTable.buffers[0];
    if (prop === Symbol.toPrimitive) return REF_METHODS.toPrimitive;

    // push/pop on a top-level array: operate directly on the array ref
    // without decoding the whole array (O(1) amortized).
    if (prop === "push" || prop === "pop") {
      const resolved = resolveArrayRef(t.mem, { key: t.key, path: [] });
      if (resolved !== null) {
        return (...args: unknown[]) =>
          mutateArrayRef(t.mem, { key: t.key, path: [] }, prop, args);
      }
    }

    return readProp(t.mem, t.key, prop, t.arrayCapacity);
  },
  set(t, prop, val) {
    t.__cache = undefined;
    // `arr[i] = v` on a top-level array: the plain-write fast path, written
    // out here and not called (one function level less, see the accessor
    // setter in `createSharedRef`). It needs the cached ArrayRef (a former
    // general write left it on the target), refreshed under the stripe. Any
    // other case (not an index, not cached, out of bounds, a value that does
    // not qualify) goes to `writeProp`, which stores it or throws.
    const index = t.__index;
    if (
      index !== undefined &&
      t.__type === TYPE_ARRAY_REF &&
      (typeof val === "number" ||
        typeof val === "boolean" ||
        (typeof val === "string" && val.length <= 11) ||
        (typeof val === "bigint" && val >= MIN_INT64 && val <= MAX_INT64))
    ) {
      const i = parseIndex(prop);
      if (i >= 0) {
        const mem = t.mem;
        const cell = mem.beginPlainWrite(index);
        if (cell >= 0) {
          let done = false;
          try {
            const ref = t.__arrayRef;
            const offset = t.__offset;
            if (
              ref !== undefined &&
              offset !== undefined &&
              t.__layoutVersion === mem.layoutVersionInLock() &&
              mem.refreshArrayRef(ref, offset) &&
              i < ref.count
            ) {
              done = true;
              if (typeof val === "number")
                mem.updateArrayNumberSlot(ref, i, val);
              else if (typeof val === "boolean") {
                mem.updateArrayBooleanSlot(ref, i, val);
              } else if (typeof val === "bigint") {
                mem.updateArrayBigIntSlot(ref, i, val);
              } else {
                done = mem.updateArrayInlineStringSlot(ref, i, val as string);
              }
            }
          } finally {
            mem.endPlainWrite(index, cell);
          }
          if (done) return true;
        }
      }
    }
    writeProp(t.mem, t.key, prop, val, t.arrayCapacity, t);
    return true;
  },
  deleteProperty() {
    throw new TypeError(
      "Shared values have a fixed shape: properties may not be added or removed",
    );
  },
};

/** Create a SharedRef proxy backed by a SharedMemory instance. */
function createSharedRef<T>(
  mem: SharedMemory,
  key: string,
  initialValue: T | undefined,
  arrayCapacity?: number,
): SharedRef<T> {
  const target = new RefTarget<T>(mem, key, arrayCapacity);

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
    // The prototype is shared by every key, so objects of the same shape also
    // share their hidden classes (a prototype of their own per key would give
    // each key its own set of Structures and property tables). The only own
    // non-data property is the hidden TARGET, which the shared methods use.
    const ref = Object.create(REF_PROTO) as Record<string | symbol, unknown>;
    Object.defineProperty(ref, TARGET, { value: target });
    for (const name of propNames) {
      const st: PropState = {
        t: target,
        name,
        cell: 0,
        cellResolved: false,
        version: -1,
        raw: -1,
        value: undefined,
        arrayProxy: undefined,
        objectProxy: undefined,
        slotOffset: undefined,
        slotLayoutVersion: -1,
        pending: undefined,
        writeBody: undefined,
      };
      Object.defineProperty(ref, name, {
        enumerable: true,
        configurable: false,
        get() {
          // Fast path inlined so the JIT can optimize the hot cache-hit read
          // without a function-call chain. The version cell doubles as a
          // seqlock: we wait (without a mutex) while a lock is held, then
          // compare the version so reads that raced a write re-decode.
          // Hit: a plain (non-atomic) read of the version cell. An atomic load
          // of a cache line that many workers read does not scale (readers of
          // the same hot key got slower with every worker added); a plain load
          // does, and a stale value only delays seeing a change.
          // `st.raw` has no lock bits, so equal means: unlocked and current.
          if (mem.versionView[st.cell] === st.raw) return st.value;
          return readPropMiss(st);
        },
        set(v: unknown) {
          target.__cache = undefined;
          // The plain-write fast path, written out here and not called: from
          // a setter, one more function level (a helper, a method, even a
          // local arrow) cost about 12 ns per write, measured (18 vs 6 ns),
          // apparently the JIT's inlining depth. Same values as
          // `writeValueInner` stores in place without allocating: a number, a
          // boolean, an int64 bigint, a string that may fit inline.
          const index = target.__index;
          if (
            index !== undefined &&
            (typeof v === "number" ||
              typeof v === "boolean" ||
              (typeof v === "string" && v.length <= 11) ||
              (typeof v === "bigint" && v >= MIN_INT64 && v <= MAX_INT64))
          ) {
            const cell = mem.beginPlainWrite(index);
            if (cell >= 0) {
              let done = true;
              try {
                const lv = mem.layoutVersionInLock();
                const slotOffset =
                  st.slotLayoutVersion === lv && st.slotOffset !== undefined
                    ? st.slotOffset
                    : resolveSlot(st, lv);
                if (typeof v === "number") mem.updateNumberSlot(slotOffset, v);
                else if (typeof v === "boolean") {
                  mem.updateBooleanSlot(slotOffset, v);
                } else if (typeof v === "bigint") {
                  mem.updateBigIntSlot(slotOffset, v);
                } else {
                  done = mem.updateInlineStringSlot(slotOffset, v as string);
                }
              } finally {
                mem.endPlainWrite(index, cell);
              }
              if (done) return;
            }
          }
          // `writeBody` is created on the first write of this accessor; the
          // value travels through `pending`, so a write allocates no closure.
          st.pending = v;
          try {
            writeLock(mem, key, (st.writeBody ??= makeWriteBody(st)), target);
          } finally {
            st.pending = undefined;
          }
        },
      });
    }
    // Fixed shape: reject adding new properties (throws in strict mode).
    Object.preventExtensions(ref);
    sharedKeyMap.set(ref, key);
    target.publicRef = ref as unknown as SharedRef<T>;
    return target.publicRef as SharedRef<T>;
  }

  // Arrays, primitives, or unknown shape: use a Proxy (index access, array
  // methods, and dynamic properties require interception).
  const proxy = new Proxy(target, REF_PROXY_HANDLER);
  sharedKeyMap.set(proxy, key);
  target.publicRef = proxy as unknown as SharedRef<T>;
  return target.publicRef as SharedRef<T>;
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
  const existing = liveRef(key);
  if (existing) return existing as SharedRef<T>;
  const ref = createSharedRef<T>(mem, key, undefined) as SharedRef<T>;
  rememberRef(key, ref as SharedRef<unknown>);
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
    __cache?: {
      version: number;
      raw: number;
      value: unknown;
      index: number;
      cell: number;
      ev: number;
    };
  },
): unknown {
  // Inline the read-cache fast path (see readProp) to avoid the polymorphic
  // {hit,value} union returned by readCachedValue. The version cell doubles as
  // a seqlock: a hit requires clear lock bits and a matching version.
  const cached = readCache.get(key);
  if (cached !== undefined && mem.versionView[cached.cell] === cached.raw) {
    return cached.value;
  }

  const index = cached !== undefined ? cached.index : getIndex(mem, key);
  const cell =
    cached !== undefined ? cached.cell : mem.getVersionCellIndex(index);

  // Wait out any in-flight lock (withReadLock/withWriteLock) so we never
  // decode a half-written object, then read the version in the same loop.
  const version = waitForVersionCell(mem, cell);

  // Cache miss: decode under the key's lock stripe (consistent against a
  // concurrent write to this key) and cache with the observed version.
  const value = mem.withKeyLock(index, () => {
    const offset = getOffset(mem, key);
    if (offset === null) {
      throw new Error(`No shared value found for key "${key}"`);
    }
    const type = mem.dataTable.getInt32(offset);
    if (type === 5) {
      // Object block. The cached layout already holds the property names and
      // slot offsets (static: the shape is fixed), so only the values are
      // decoded; reading the names from the StringTable again on every miss
      // (a TextDecoder call each) was over half the time of this read.
      const layout = getObjectLayout(mem, key);
      const obj: Record<string, unknown> = {};
      if (layout !== null && layout.totalOffset === offset) {
        for (const [name, slotOffset] of layout.properties) {
          const primitive = mem.readPrimitiveAt(slotOffset);
          obj[name] =
            primitive !== NOT_PRIMITIVE
              ? primitive
              : decodeValue(mem, mem.readValueSlot(slotOffset));
        }
        return obj;
      }
      for (const [name, slot] of mem.readObject(offset)) {
        obj[name] = decodeValue(mem, slot);
      }
      return obj;
    }
    // Single value slot (primitive or array).
    return decodeValue(mem, mem.readValueSlot(offset));
  });

  const entry = {
    version,
    raw: version << VERSION_LOCK_SHIFT_BITS,
    value,
    index,
    cell,
    ev: -1,
  };
  readCache.set(key, entry);
  if (cacheTarget) cacheTarget.__cache = entry;
  return value;
}

/** Write a full value for a key to shared memory. */
// State of the `writeValue` in progress (see `writeProp` above for why): the
// lock body is a module-level function, so a write allocates no closure. Saved
// and restored by `writeValue` so a write started from inside a write cannot
// clobber the outer one.
let wvMem: SharedMemory;
let wvKey = "";
let wvValue: unknown;
let wvCapacity: number | undefined;
let wvTarget: WriteTarget | undefined;

function writeValueBody(): void {
  writeValueInner(wvMem, wvKey, wvValue, wvCapacity, wvTarget);
}

function writeValue(
  mem: SharedMemory,
  key: string,
  value: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  const sMem = wvMem;
  const sKey = wvKey;
  const sValue = wvValue;
  const sCapacity = wvCapacity;
  const sTarget = wvTarget;
  wvMem = mem;
  wvKey = key;
  wvValue = value;
  wvCapacity = arrayCapacity;
  wvTarget = target;
  try {
    // Serialize the write under the key's lock stripe (see `writeLock`).
    writeLock(mem, key, writeValueBody, target);
  } finally {
    wvMem = sMem;
    wvKey = sKey;
    wvValue = sValue;
    wvCapacity = sCapacity;
    wvTarget = sTarget;
  }
}

function writeValueInner(
  mem: SharedMemory,
  key: string,
  value: unknown,
  arrayCapacity?: number,
  target?: WriteTarget,
): void {
  // While we hold the key's stripe the layout version is stable
  // (defragmentation takes every stripe), so we read it once and reuse it for
  // all checks below.
  const cachedLv = mem.layoutVersionInLock();
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
      const valueObj = value as Record<string, unknown>;
      const layout = getObjectLayout(mem, key);
      if (layout !== null && layout.totalOffset === existing) {
        // The cached layout holds the property names and slot offsets (the
        // shape is fixed), so nothing is read back from the StringTable and no
        // temporary arrays/sets are built. Validate first so a rejected write
        // leaves the object untouched.
        let present = 0;
        for (const name of layout.properties.keys()) {
          if (!(name in valueObj)) {
            throw new TypeError(
              `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
            );
          }
          present++;
        }
        let total = 0;
        for (const _name in valueObj) total++;
        if (total !== present) {
          throw new TypeError(
            `Value for key "${key}" has a fixed shape: properties may not be added or removed`,
          );
        }
        for (const [name, slotOffset] of layout.properties) {
          storeObjectSlot(mem, slotOffset, valueObj[name], arrayCapacity);
        }
        bumpTarget(mem, key, target);
        return;
      }
      const properties = mem.readObject(existing);
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
    assertPlainObject(value);
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
  return writeLock(mem, key, () => {
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
  return writeLock(mem, key, () => {
    const current = readValue(mem, key) as T;
    const result = fn(current);
    writeValue(mem, key, current, arrayCapacity);
    return result;
  });
}

/**
 * Layouts of nested object blocks, by DataTable offset. A block's layout never
 * changes (fixed shape), a replaced sub-object gets a new block from the bump
 * allocator, and only a defragmentation (which bumps the layout version) puts
 * another block at a used offset, so an entry holds until the layout version
 * changes. Spares the property-name decoding of `getObjectLayoutAtOffset` on
 * every write through a nested object.
 */
const nestedLayouts = new Map<number, ObjectLayout>();
let nestedLayoutsVersion = -1;

function nestedLayoutAt(
  mem: SharedMemory,
  offset: number,
): ObjectLayout | null {
  const lv = mem.getLayoutVersion();
  if (lv !== nestedLayoutsVersion) {
    nestedLayouts.clear();
    nestedLayoutsVersion = lv;
  }
  let layout = nestedLayouts.get(offset);
  if (layout === undefined) {
    const fresh = mem.getObjectLayoutAtOffset(offset);
    if (fresh === null) return null;
    // Replaced sub-objects leave dead blocks behind; keep the map bounded.
    if (nestedLayouts.size >= 1024) nestedLayouts.clear();
    nestedLayouts.set(offset, fresh);
    layout = fresh;
  }
  return layout;
}

/**
 * Resolve the array-ref slot for a locator, returning the current array-ref
 * ValueSlot and a `write` function that persists a new array-ref slot back to
 * its location (a DataTable slot of an object, or of the top-level value, or
 * an ArrayTable slot of an enclosing array). The path may run through objects
 * and arrays in any order (`o.p.t`, `grid[0]`, `o.m[1]`, `o.list[2].tags`).
 * Returns null if the value at the locator is not an array.
 *
 * `offset` (the slot's DataTable offset) is given only for a top-level array
 * and an array property of the top-level object: those slots stay where they
 * are until a defragmentation. Deeper slots live in a nested object block or
 * an array that a write can replace by a new one without bumping the layout
 * version, so callers must not cache them.
 */
function resolveArrayRef(
  mem: SharedMemory,
  locator: ArrayLocator,
): {
  slot: ValueSlot;
  write: (s: ValueSlot) => void;
  /** DataTable offset of the slot, when it may be cached (see above). */
  offset?: number;
} | null {
  const { key, path } = locator;
  const rootOffset = getOffset(mem, key);
  if (rootOffset === null) return null;
  if (path.length === 0) {
    const slot = mem.readValueSlot(rootOffset);
    if (slot.type !== TYPE_ARRAY_REF) return null;
    return {
      slot,
      write: (s) => mem.updateValueSlot(rootOffset, s),
      offset: rootOffset,
    };
  }
  // The container the next step reads from: an object block (DataTable
  // offset) or an array.
  let objectAt: number | null = null;
  let array: ArrayRef | null = null;
  if (mem.dataTable.getInt32(rootOffset) === 5 /* TYPE_OBJECT */) {
    objectAt = rootOffset;
  } else {
    const rootSlot = mem.readValueSlot(rootOffset);
    if (rootSlot.type !== TYPE_ARRAY_REF) return null;
    array = { offset: rootSlot.a, count: rootSlot.b, capacity: rootSlot.c };
  }
  for (let i = 0; i < path.length; i++) {
    const step = path[i]!;
    const last = i === path.length - 1;
    let slot: ValueSlot;
    let write: (s: ValueSlot) => void;
    let dataOffset: number | undefined;
    if (step.kind === "prop") {
      if (objectAt === null) return null;
      const layout =
        objectAt === rootOffset
          ? getObjectLayout(mem, key)
          : nestedLayoutAt(mem, objectAt);
      const slotOffset = layout?.properties.get(step.name);
      if (slotOffset === undefined) return null;
      slot = mem.readValueSlot(slotOffset);
      write = (s) => mem.updateValueSlot(slotOffset, s);
      dataOffset = slotOffset;
    } else {
      if (array === null || step.index >= array.count) return null;
      const ref = array;
      const index = step.index;
      slot = mem.readArraySlot(ref, index);
      write = (s) => mem.updateArraySlot(ref, index, s);
    }
    if (last) {
      if (slot.type !== TYPE_ARRAY_REF) return null;
      return path.length === 1 && dataOffset !== undefined
        ? { slot, write, offset: dataOffset }
        : { slot, write };
    }
    if (slot.type === TYPE_OBJECT_REF) {
      objectAt = slot.a;
      array = null;
    } else if (slot.type === TYPE_ARRAY_REF) {
      array = { offset: slot.a, count: slot.b, capacity: slot.c };
      objectAt = null;
    } else {
      return null;
    }
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
  return writeLock(mem, locator.key, () => {
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

/**
 * A read of one array element that missed the whole-value cache (it follows a
 * write): read just that element's slot, without decoding the whole root value
 * (a large array or object decoded for one element is what made such reads
 * slow). `name` is `null` for a top-level array, or the array property of an
 * object value. The first miss at a given version takes this path; a second
 * miss at the same version returns `NOT_PRIMITIVE` so the caller decodes the
 * value once and fills the cache, keeping read-heavy loops on the fast cached
 * path. Also returns `NOT_PRIMITIVE` when the general path is needed (first
 * access, a held object lock, nested array/object elements, other shapes);
 * `undefined` means the index is out of bounds.
 */
function tryReadElement(
  mem: SharedMemory,
  key: string,
  name: string | null,
  index: number,
): unknown {
  const cached = readCache.get(key);
  if (cached === undefined) return NOT_PRIMITIVE;
  const raw = mem.versionView[cached.cell]!;
  if ((raw & VERSION_LOCK_MASK) !== 0) return NOT_PRIMITIVE;
  const version = raw >> VERSION_LOCK_SHIFT_BITS;
  if (cached.version === version || cached.ev === version) {
    return NOT_PRIMITIVE;
  }
  cached.ev = version;
  // Consistent against concurrent writers of this key, like the whole-value
  // read, but without a closure.
  const stripe = mem.lockKey(cached.index);
  try {
    let refSlotOffset: number;
    if (name === null) {
      const offset = mem.lookupByIndex(cached.index);
      if (offset === null) return NOT_PRIMITIVE;
      refSlotOffset = offset;
    } else {
      const layout = getObjectLayout(mem, key);
      const so = layout === null ? undefined : layout.properties.get(name);
      if (so === undefined) return NOT_PRIMITIVE;
      refSlotOffset = so;
    }
    return mem.readArrayElementAt(refSlotOffset, index);
  } finally {
    mem.unlockKey(stripe);
  }
}

/**
 * Array index encoded in a property key, or -1 if `prop` is not a non-empty
 * string of decimal digits (the same set the former `/^\d+$/` test accepted).
 * A character loop instead of a regular expression plus `Number()`: array
 * proxies parse the key of every element access and write.
 */
function parseIndex(prop: string | symbol): number {
  if (typeof prop !== "string") return -1;
  const length = prop.length;
  if (length === 0) return -1;
  let index = 0;
  for (let i = 0; i < length; i++) {
    const digit = prop.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return -1;
    // For 16+ digits `index` overflows 2^53 and the value is rounded, but any
    // such index is beyond the Int32 array bounds anyway, so the rounding does
    // not matter: the caller's bounds check rejects it just the same.
    index = index * 10 + digit;
  }
  return index;
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
  const index = parseIndex(prop);
  if (index >= 0) {
    const element = value[index];
    if (element !== null && typeof element === "object") {
      if (sharedKeyMap.has(element)) return element;
      return childProxy(
        topLevelChildren(key),
        mem,
        key,
        NO_PATH,
        "index",
        index,
        Array.isArray(element),
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
  // DataTable offset of the array-ref slot, for a locator that ends there (a
  // top-level array or an array property); undefined for arrays nested in
  // arrays, which are resolved again on every write.
  let cachedSlotOffset: number | undefined;
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
   * The array's current ref. Where its slot is can change only with the layout
   * version (defragmentation); what the slot says (the block, the count) also
   * changes without it: a whole-value write stores a new block, push/pop and
   * `length` change the count in place, here or in another worker. So the
   * cached ref object is refreshed from the slot on every call.
   */
  // Only ever called from writeArrayProp, which runs inside the key's stripe
  // lock, so the layout version can be read without atomics.
  function getRef(): {
    offset: number;
    count: number;
    capacity: number;
  } {
    const lv = mem.layoutVersionInLock();
    if (cachedLayoutVersion !== lv) {
      cachedRef = undefined;
      cachedSlotOffset = undefined;
      cachedLayoutVersion = lv;
    }
    if (
      cachedRef !== undefined &&
      cachedSlotOffset !== undefined &&
      mem.refreshArrayRef(cachedRef, cachedSlotOffset)
    ) {
      return cachedRef;
    }
    const resolved = resolveArrayRef(mem, locator);
    if (resolved === null) {
      throw new TypeError("Value is not an array");
    }
    cachedRef = {
      offset: resolved.slot.a,
      count: resolved.slot.b,
      capacity: resolved.slot.c,
    };
    cachedSlotOffset = resolved.offset;
    return cachedRef;
  }

  /**
   * Write a single array slot in place. Defined once (not per call) so the
   * set handler can inline the writeLock without allocating a closure on
   * every write.
   */
  function writeArrayProp(arrProp: string | symbol, val: unknown): boolean {
    const index = parseIndex(arrProp);
    if (index >= 0) {
      const ref = getRef();
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

  const children = newChildProxies();

  // Pending array write (see the proxy's `set` handler).
  let apProp: string | symbol = "";
  let apVal: unknown;
  const arraySetBody = (): boolean => writeArrayProp(apProp, apVal);

  // The read-cache entry of the key and the array at the end of the locator's
  // path in its value, remembered by the last index read: while the entry is
  // current (the version cell still equals its `raw`), an index read is one
  // comparison and an array access, without the Map lookup and the path walk.
  // The entry's value is never changed (a write makes a new entry), so the
  // array found in it stays valid as long as the entry does.
  let hitEntry: { raw: number; cell: number; value: unknown } | undefined;
  let hitArray: unknown[] = [];

  return new Proxy([] as unknown[], {
    get(_target, arrProp) {
      // Index reads first: they are the hot path, and every name check below
      // would be paid on each of them (as in `REF_PROXY_HANDLER.get`).
      const index = parseIndex(arrProp);
      if (index >= 0) {
        if (
          hitEntry !== undefined &&
          mem.versionView[hitEntry.cell] === hitEntry.raw
        ) {
          const element = hitArray[index];
          if (element === null || typeof element !== "object") return element;
        }
        let root: unknown;
        const cached = readCache.get(key);
        if (
          cached !== undefined &&
          mem.versionView[cached.cell] === cached.raw
        ) {
          root = cached.value;
        } else {
          // Miss (typically right after a write). For a one-step path to an
          // array property, read just the element instead of decoding the
          // whole root object.
          if (locator.path.length === 1) {
            const step = locator.path[0]!;
            if (step.kind === "prop") {
              const fast = tryReadElement(mem, key, step.name, index);
              if (fast !== NOT_PRIMITIVE) return fast;
            }
          }
          root = readValue(mem, key);
        }
        const rootArray = readPathValue(mem, locator, root);
        if (!Array.isArray(rootArray)) {
          throw new TypeError("Value is not an array");
        }
        // Remember the entry this array came from (`readValue` stored a new
        // one on a miss), for the next index read.
        const entry = readCache.get(key);
        if (entry !== undefined && entry.value === root) {
          hitEntry = entry;
          hitArray = rootArray;
        }
        const element = rootArray[index];
        if (element !== null && typeof element === "object") {
          if (sharedKeyMap.has(element)) return element;
          return childProxy(
            children,
            mem,
            locator.key,
            locator.path,
            "index",
            index,
            Array.isArray(element),
            arrayCapacity,
          );
        }
        return element;
      }
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
      // `arr[i] = v` of a number, a boolean, an int64 bigint or a string that
      // may fit inline: the plain-write fast path, written out here and not
      // called (one function level less, see the accessor setter in
      // `createSharedRef`); the cached ref's common case inline too. The
      // version cell index is resolved by the first general write.
      const cell0 = cachedIndex;
      if (
        cell0 !== undefined &&
        (typeof val === "number" ||
          typeof val === "boolean" ||
          (typeof val === "string" && val.length <= 11) ||
          (typeof val === "bigint" && val >= MIN_INT64 && val <= MAX_INT64))
      ) {
        const index = parseIndex(arrProp);
        if (index >= 0) {
          const cell = mem.beginPlainWrite(cell0);
          if (cell >= 0) {
            let done = true;
            try {
              const lv = mem.layoutVersionInLock();
              const ref =
                cachedLayoutVersion === lv &&
                cachedRef !== undefined &&
                cachedSlotOffset !== undefined &&
                mem.refreshArrayRef(cachedRef, cachedSlotOffset)
                  ? cachedRef
                  : getRef();
              if (index >= ref.count) {
                throw new RangeError(
                  `Index ${index} out of bounds for array of length ${ref.count}`,
                );
              }
              if (typeof val === "number") {
                mem.updateArrayNumberSlot(ref, index, val);
              } else if (typeof val === "boolean") {
                mem.updateArrayBooleanSlot(ref, index, val);
              } else if (typeof val === "bigint") {
                mem.updateArrayBigIntSlot(ref, index, val);
              } else {
                done = mem.updateArrayInlineStringSlot(
                  ref,
                  index,
                  val as string,
                );
              }
            } finally {
              mem.endPlainWrite(cell0, cell);
            }
            if (done) return true;
          }
        }
      }
      // In-place update: write only the affected array slot instead of
      // decoding and re-encoding the whole value. Serialize under the key's
      // lock stripe (see `writeLock`). The pending property and value travel
      // through `apProp`/`apVal` (saved and restored for re-entrancy) so the
      // write allocates no closure.
      const sProp = apProp;
      const sVal = apVal;
      apProp = arrProp;
      apVal = val;
      try {
        return writeLock(mem, locator.key, arraySetBody);
      } finally {
        apProp = sProp;
        apVal = sVal;
      }
    },
  });
}
