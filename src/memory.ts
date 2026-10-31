import { GrowableBuffer } from "./growable-buffer.ts";
import { Mutex } from "./mutex.ts";

/**
 * The 4-buffer shared memory architecture.
 *
 *   1) Index Table   — maps object keys → DataTable offsets
 *   2) DataTable     — stores objects, arrays, strings as references
 *   3) StringTable   — append-only storage for strings
 *   4) ArrayTable    — append-only storage for arrays
 *
 * Value slot layout (16 bytes):
 *   [0..3]   type (Int32): 0=number, 1=boolean, 2=bigint, 3=string-ref, 4=array-ref, 6=bigint-str
 *   [4..7]   payload A
 *   [8..11]  payload B
 *   [12..15] payload C
 *
 *   number     -> float64 in [4..11]
 *   boolean    -> [4] = 0/1
 *   bigint     -> int64 in [4..11] (only values that fit in 64 bits)
 *   bigint-str -> [4..7]=offset, [8..11]=length (into StringTable); for bigints
 *                 too large for 64 bits, stored as their decimal string
 *   string-ref -> [4..7]=offset, [8..11]=length (into StringTable)
 *   array-ref  -> [4..7]=offset, [8..11]=count (into ArrayTable)
 *
 * Object block layout in DataTable:
 *   [0..3]   type = OBJECT (5)
 *   [4..7]   property count
 *   [8..11]  reserved
 *   [12..15] reserved
 *   then propertyCount * (nameRef(8 bytes) + valueSlot(16 bytes))
 *
 * Index Table entry (12 bytes):
 *   [0..3]   key string offset
 *   [4..7]   key string length
 *   [8..11]  data offset (into DataTable)
 */

export const TYPE_NUMBER = 0;
export const TYPE_BOOLEAN = 1;
export const TYPE_BIGINT = 2;
export const TYPE_STRING_REF = 3;
export const TYPE_ARRAY_REF = 4;
export const TYPE_OBJECT = 5;
export const TYPE_BIGINT_STR = 6;

const SLOT_SIZE = 16;
const OBJECT_HEADER = 16;
const NAME_REF_SIZE = 8;
const INDEX_ENTRY_SIZE = 12;
const INDEX_HEADER = 4;
/** Size of the objectId header at the start of each array block. */
const ARRAY_HEADER = 4;

const DEFAULT_INITIAL = 1024;
const DEFAULT_MAX = 64 * 1024 * 1024; // 64 MiB
const DEFAULT_INTERN_CAPACITY = 256;
const DEFAULT_INTERN_MAX = 1 << 16; // 65536 entries

/**
 * Reusable DataView for packing/unpacking 64-bit values (number, bigint) into
 * the two 32-bit halves of a ValueSlot. Each worker has its own module
 * instance, and all uses happen under the shared lock (or on a single thread),
 * so reusing one view is safe and avoids allocating a buffer per call.
 */
const slotView = new DataView(new ArrayBuffer(8));

export interface StringRef {
  offset: number;
  length: number;
}

export interface ArrayRef {
  /**
   * Byte offset of the array block in the ArrayTable, pointing at the 4-byte
   * objectId header. The value slots start at `offset + ARRAY_HEADER`.
   */
  offset: number;
  count: number;
  /** Number of slots reserved for this array (>= count). */
  capacity: number;
}

export interface ValueSlot {
  type: number;
  a: number;
  b: number;
  c: number;
}

/**
 * The stable layout of an object value in the DataTable: its total offset and
 * the slot offset of each property. Static for the lifetime of the object.
 */
export interface ObjectLayout {
  totalOffset: number;
  properties: Map<string, number>;
}

/** Encode a number (float64) into a ValueSlot. */
export function numberSlot(value: number): ValueSlot {
  slotView.setFloat64(0, value, true);
  return { type: TYPE_NUMBER, a: slotView.getInt32(0, true), b: slotView.getInt32(4, true), c: 0 };
}

/** Encode a boolean into a ValueSlot. */
export function booleanSlot(value: boolean): ValueSlot {
  return { type: TYPE_BOOLEAN, a: value ? 1 : 0, b: 0, c: 0 };
}

/** Encode a bigint (int64) into a ValueSlot. */
export function bigintSlot(value: bigint): ValueSlot {
  slotView.setBigInt64(0, value, true);
  return { type: TYPE_BIGINT, a: slotView.getInt32(0, true), b: slotView.getInt32(4, true), c: 0 };
}

/** Encode a string reference into a ValueSlot. */
export function stringRefSlot(ref: StringRef): ValueSlot {
  return { type: TYPE_STRING_REF, a: ref.offset, b: ref.length, c: 0 };
}

/** Encode a bigint stored as a decimal string into a ValueSlot. */
export function bigintStrSlot(ref: StringRef): ValueSlot {
  return { type: TYPE_BIGINT_STR, a: ref.offset, b: ref.length, c: 0 };
}

/** Encode an array reference into a ValueSlot. */
export function arrayRefSlot(ref: ArrayRef): ValueSlot {
  return { type: TYPE_ARRAY_REF, a: ref.offset, b: ref.count, c: ref.capacity };
}

/** Decode a ValueSlot into a JS value (primitives) or a ref object. */
export function decodeSlot(slot: ValueSlot): unknown {
  switch (slot.type) {
    case TYPE_NUMBER: {
      slotView.setInt32(0, slot.a, true);
      slotView.setInt32(4, slot.b, true);
      return slotView.getFloat64(0, true);
    }
    case TYPE_BOOLEAN:
      return slot.a === 1;
    case TYPE_BIGINT: {
      slotView.setInt32(0, slot.a, true);
      slotView.setInt32(4, slot.b, true);
      return slotView.getBigInt64(0, true);
    }
    case TYPE_STRING_REF:
      return { offset: slot.a, length: slot.b };
    case TYPE_ARRAY_REF:
      return { offset: slot.a, count: slot.b, capacity: slot.c };
    default:
      throw new Error(`Unknown slot type ${slot.type}`);
  }
}

/**
 * Manages the four shared buffers and provides operations to store and read
 * strings, arrays, and objects.
 */
export class SharedMemory {
  readonly indexTable: GrowableBuffer;
  readonly dataTable: GrowableBuffer;
  readonly stringTable: GrowableBuffer;
  readonly arrayTable: GrowableBuffer;
  /**
   * Per-key version counter (one Int32 per key index). Incremented on every
   * write so workers can invalidate their read caches cross-worker.
   */
  readonly versionTable: GrowableBuffer;
  /** Cached Int32Array view over the version table (rebuilt on growth). */
  private versionView: Int32Array;
  /** Cross-worker mutex protecting all read/write operations. */
  readonly lock: Mutex;

  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  /**
   * LRU cache mapping interned strings to their stable StringTable refs.
   * Per-worker (each worker has its own module instance). Refs are stable
   * because the StringTable is append-only, so a cached ref stays valid.
   * Grows dynamically up to `internMax`; evicts least-recently-used entries
   * beyond `internCapacity`.
   */
  private readonly internCache = new Map<string, StringRef>();
  private internCapacity: number;
  private readonly internMax: number;
  /** Fast path: the most recently interned string and its ref. */
  private lastInterned: string | undefined;
  private lastInternedRef: StringRef | undefined;

  /**
   * Monotonic counter for stable object/array identity. Each object and array
   * gets a unique id that is independent of its DataTable/ArrayTable offset
   * (which changes during defragmentation). Used to key the refcount table.
   */
  private nextObjectId = 1;

  constructor(options?: {
    initialSize?: number;
    maxByteLength?: number;
    lock?: Mutex;
    internCapacity?: number;
    internMax?: number;
    buffers?: {
      indexTable?: SharedArrayBuffer;
      dataTable?: SharedArrayBuffer;
      stringTable?: SharedArrayBuffer;
      arrayTable?: SharedArrayBuffer;
      versionTable?: SharedArrayBuffer;
    };
  }) {
    const initial = options?.initialSize ?? DEFAULT_INITIAL;
    const max = options?.maxByteLength ?? DEFAULT_MAX;
    const buffers = options?.buffers;
    this.indexTable = new GrowableBuffer(
      buffers?.indexTable ?? new SharedArrayBuffer(initial, { maxByteLength: max }),
      max,
    );
    this.dataTable = new GrowableBuffer(
      buffers?.dataTable ?? new SharedArrayBuffer(initial, { maxByteLength: max }),
      max,
    );
    this.stringTable = new GrowableBuffer(
      buffers?.stringTable ?? new SharedArrayBuffer(initial, { maxByteLength: max }),
      max,
    );
    this.arrayTable = new GrowableBuffer(
      buffers?.arrayTable ?? new SharedArrayBuffer(initial, { maxByteLength: max }),
      max,
    );
    this.versionTable = new GrowableBuffer(
      buffers?.versionTable ?? new SharedArrayBuffer(initial, { maxByteLength: max }),
      max,
    );
    this.versionView = new Int32Array(this.versionTable.buffer);
    this.lock = options?.lock ?? new Mutex();
    this.internCapacity = options?.internCapacity ?? DEFAULT_INTERN_CAPACITY;
    this.internMax = options?.internMax ?? DEFAULT_INTERN_MAX;
  }

  /** Run `fn` while holding the shared lock. */
  withLock<T>(fn: () => T): T {
    return this.lock.withLock(fn);
  }

  // ---------------------------------------------------------------------------
  // StringTable
  // ---------------------------------------------------------------------------

  /**
   * Append a string to the StringTable and return its reference.
   *
   * Interns the string in a per-worker LRU cache: repeated writes of the same
   * string reuse the existing StringTable ref instead of re-encoding and
   * re-copying the bytes. The cache grows dynamically up to `internMax` and
   * evicts the least-recently-used entry once it exceeds `internCapacity`.
   */
  storeString(value: string): StringRef {
    // Fast path: the same string as the previous call reuses its ref without
    // touching the LRU map (avoids the expensive delete+set on every hit).
    if (value === this.lastInterned) {
      return this.lastInternedRef!;
    }

    const cached = this.internCache.get(value);
    if (cached !== undefined) {
      // Refresh LRU position (Map preserves insertion order; re-insert moves
      // the entry to the most-recently-used end).
      this.internCache.delete(value);
      this.internCache.set(value, cached);
      this.lastInterned = value;
      this.lastInternedRef = cached;
      return cached;
    }

    const bytes = this.encoder.encode(value);
    const offset = this.stringTable.byteLength;
    this.stringTable.ensureCapacity(offset + bytes.byteLength);
    const view = this.stringTable.getView();
    for (let i = 0; i < bytes.byteLength; i++) {
      view.setUint8(offset + i, bytes[i]!);
    }
    this.stringTable.advance(bytes.byteLength);
    const ref: StringRef = { offset, length: bytes.byteLength };

    // Insert into the cache, growing capacity up to `internMax` before evicting.
    if (this.internCache.size >= this.internCapacity) {
      if (this.internCapacity < this.internMax) {
        this.internCapacity = Math.min(this.internCapacity * 2, this.internMax);
      } else {
        // Evict the least-recently-used entry (first in insertion order).
        const oldest = this.internCache.keys().next().value;
        if (oldest !== undefined) this.internCache.delete(oldest);
      }
    }
    this.internCache.set(value, ref);
    this.lastInterned = value;
    this.lastInternedRef = ref;
    return ref;
  }

  /**
   * Clear the per-worker string interning cache.
   *
   * Call this if the StringTable is ever compacted/defragmented (which would
   * invalidate cached refs). The cache is repopulated lazily on the next
   * `storeString` calls.
   */
  clearInternCache(): void {
    this.internCache.clear();
    this.lastInterned = undefined;
    this.lastInternedRef = undefined;
  }

  /** Read a string from the StringTable by reference. */
  readString(ref: StringRef): string {
    const view = this.stringTable.getView();
    const bytes = new Uint8Array(this.stringTable.buffer, ref.offset, ref.length);
    return this.decoder.decode(bytes);
  }

  // ---------------------------------------------------------------------------
  // ArrayTable
  // ---------------------------------------------------------------------------

  /**
   * Append an array of value slots to the ArrayTable and return its reference.
   *
   * Each array block starts with a 4-byte objectId header (for refcounting),
   * followed by `capacity` value slots. `capacity` is the number of slots
   * reserved for the array (>= slots.length). The extra slots are padding so
   * `push` can grow the array in place without overwriting the next array.
   * When the padding is exhausted, the array must be moved (see `moveArray`).
   */
  storeArray(slots: ValueSlot[], capacity?: number): ArrayRef {
    const count = slots.length;
    const cap = Math.max(capacity ?? count, 1);
    const offset = this.arrayTable.byteLength;
    this.arrayTable.ensureCapacity(offset + ARRAY_HEADER + cap * SLOT_SIZE);
    const view = this.arrayTable.getView();
    const objectId = this.nextObjectId++;
    view.setInt32(offset, objectId, true);
    for (let i = 0; i < count; i++) {
      writeSlot(view, offset + ARRAY_HEADER + i * SLOT_SIZE, slots[i]!);
    }
    this.arrayTable.advance(ARRAY_HEADER + cap * SLOT_SIZE);
    return { offset, count, capacity: cap };
  }

  /** Read an array of value slots from the ArrayTable by reference. */
  readArray(ref: ArrayRef): ValueSlot[] {
    const view = this.arrayTable.getView();
    const slots: ValueSlot[] = [];
    for (let i = 0; i < ref.count; i++) {
      slots.push(readSlot(view, ref.offset + ARRAY_HEADER + i * SLOT_SIZE));
    }
    return slots;
  }

  /** Update a single value slot of an array in the ArrayTable in place. */
  updateArraySlot(ref: ArrayRef, index: number, slot: ValueSlot): void {
    writeSlot(this.arrayTable.getView(), ref.offset + ARRAY_HEADER + index * SLOT_SIZE, slot);
  }

  /** Read a single value slot of an array from the ArrayTable. */
  readArraySlot(ref: ArrayRef, index: number): ValueSlot {
    return readSlot(this.arrayTable.getView(), ref.offset + ARRAY_HEADER + index * SLOT_SIZE);
  }

  /** Read the stable objectId of an array block in the ArrayTable. */
  getArrayObjectId(offset: number): number {
    return this.arrayTable.getView().getInt32(offset, true);
  }

  /**
   * Move an array to a new location with a larger capacity, copying its slots.
   * Returns the new reference. The caller must update the array-ref slot in
   * the DataTable to point at the new location.
   */
  moveArray(ref: ArrayRef, newCapacity: number): ArrayRef {
    const newOffset = this.arrayTable.byteLength;
    this.arrayTable.ensureCapacity(newOffset + ARRAY_HEADER + newCapacity * SLOT_SIZE);
    const view = this.arrayTable.getView();
    const objectId = this.getArrayObjectId(ref.offset);
    view.setInt32(newOffset, objectId, true);
    for (let i = 0; i < ref.count; i++) {
      writeSlot(
        view,
        newOffset + ARRAY_HEADER + i * SLOT_SIZE,
        readSlot(view, ref.offset + ARRAY_HEADER + i * SLOT_SIZE),
      );
    }
    this.arrayTable.advance(ARRAY_HEADER + newCapacity * SLOT_SIZE);
    return { offset: newOffset, count: ref.count, capacity: newCapacity };
  }

  /**
   * Append a slot to an array, growing it in place if capacity allows, or
   * moving it to a new location with doubled capacity otherwise. Returns the
   * (possibly new) reference; the caller must update the array-ref slot in the
   * DataTable if the reference changed.
   */
  appendArraySlot(ref: ArrayRef, slot: ValueSlot): ArrayRef {
    if (ref.count < ref.capacity) {
      writeSlot(this.arrayTable.getView(), ref.offset + ARRAY_HEADER + ref.count * SLOT_SIZE, slot);
      return { offset: ref.offset, count: ref.count + 1, capacity: ref.capacity };
    }
    const moved = this.moveArray(ref, Math.max(ref.capacity * 2, 1));
    writeSlot(this.arrayTable.getView(), moved.offset + ARRAY_HEADER + moved.count * SLOT_SIZE, slot);
    return { offset: moved.offset, count: moved.count + 1, capacity: moved.capacity };
  }

  // ---------------------------------------------------------------------------
  // DataTable
  // ---------------------------------------------------------------------------

  /** Store a single value slot in the DataTable and return its offset. */
  storeValueSlot(slot: ValueSlot): number {
    const offset = this.dataTable.byteLength;
    this.dataTable.ensureCapacity(offset + SLOT_SIZE);
    writeSlot(this.dataTable.getView(), offset, slot);
    this.dataTable.advance(SLOT_SIZE);
    return offset;
  }

  /** Read a single value slot from the DataTable. */
  readValueSlot(offset: number): ValueSlot {
    return readSlot(this.dataTable.getView(), offset);
  }

  /** Update a single value slot in the DataTable. */
  updateValueSlot(offset: number, slot: ValueSlot): void {
    writeSlot(this.dataTable.getView(), offset, slot);
  }

  /**
   * Create an object in the DataTable.
   *
   * @param properties array of [name, valueSlot] pairs
   * @returns the byte offset of the object block in the DataTable
   */
  createObject(properties: Array<[string, ValueSlot]>): number {
    const blockSize = OBJECT_HEADER + properties.length * (NAME_REF_SIZE + SLOT_SIZE);
    const offset = this.dataTable.byteLength;
    this.dataTable.ensureCapacity(offset + blockSize);
    const view = this.dataTable.getView();

    const objectId = this.nextObjectId++;
    view.setInt32(offset, TYPE_OBJECT, true);
    view.setInt32(offset + 4, properties.length, true);
    view.setInt32(offset + 8, objectId, true);

    let cursor = offset + OBJECT_HEADER;
    for (const [name, slot] of properties) {
      const nameRef = this.storeString(name);
      view.setInt32(cursor, nameRef.offset, true);
      view.setInt32(cursor + 4, nameRef.length, true);
      cursor += NAME_REF_SIZE;
      writeSlot(view, cursor, slot);
      cursor += SLOT_SIZE;
    }
    this.dataTable.advance(blockSize);
    return offset;
  }

  /** Read an object's properties from the DataTable. */
  readObject(offset: number): Array<[string, ValueSlot]> {
    const view = this.dataTable.getView();
    const count = view.getInt32(offset + 4, true);
    const properties: Array<[string, ValueSlot]> = [];
    let cursor = offset + OBJECT_HEADER;
    for (let i = 0; i < count; i++) {
      const nameOffset = view.getInt32(cursor, true);
      const nameLength = view.getInt32(cursor + 4, true);
      const name = this.readString({ offset: nameOffset, length: nameLength });
      cursor += NAME_REF_SIZE;
      const slot = readSlot(view, cursor);
      cursor += SLOT_SIZE;
      properties.push([name, slot]);
    }
    return properties;
  }

  /** Read the stable objectId of an object block in the DataTable. */
  getObjectId(offset: number): number {
    return this.dataTable.getView().getInt32(offset + 8, true);
  }

  /**
   * Get the stable layout of an object value: its total DataTable offset and
   * the slot offset of each property.
   *
   * Because object properties may not be added or removed, the layout is
   * static for the lifetime of the object (it only changes if the object is
   * moved by a future GC/defragmentation). Callers can cache it and read
   * individual property slots directly without decoding the whole object.
   *
   * Returns null if the key does not exist or is not an object.
   */
  getObjectLayout(key: string): ObjectLayout | null {
    const offset = this.lookup(key);
    if (offset === null) return null;
    const view = this.dataTable.getView();
    if (view.getInt32(offset, true) !== TYPE_OBJECT) return null;
    const count = view.getInt32(offset + 4, true);
    const properties = new Map<string, number>();
    let cursor = offset + OBJECT_HEADER;
    for (let i = 0; i < count; i++) {
      const nameOffset = view.getInt32(cursor, true);
      const nameLength = view.getInt32(cursor + 4, true);
      const name = this.readString({ offset: nameOffset, length: nameLength });
      cursor += NAME_REF_SIZE;
      properties.set(name, cursor);
      cursor += SLOT_SIZE;
    }
    return { totalOffset: offset, properties };
  }

  /** Update a single value slot of an object in the DataTable. */
  updateObjectSlot(offset: number, propertyIndex: number, slot: ValueSlot): void {
    const view = this.dataTable.getView();
    const slotOffset = offset + OBJECT_HEADER + propertyIndex * (NAME_REF_SIZE + SLOT_SIZE) + NAME_REF_SIZE;
    writeSlot(view, slotOffset, slot);
  }

  // ---------------------------------------------------------------------------
  // Index Table
  // ---------------------------------------------------------------------------

  /** Look up a key in the Index Table, returning the DataTable offset or null. */
  lookup(key: string): number | null {
    const index = this.lookupIndex(key);
    if (index === null) return null;
    return this.lookupByIndex(index);
  }

  /** Read the DataTable offset for a known stable index, or null if absent. */
  lookupByIndex(index: number): number | null {
    const view = this.indexTable.getView();
    const count = view.getInt32(0, true);
    if (index >= count) return null;
    const entryOffset = INDEX_HEADER + index * INDEX_ENTRY_SIZE;
    return view.getInt32(entryOffset + 8, true);
  }

  /**
   * Look up a key's stable index in the Index Table, or null if absent.
   *
   * The index is the key's position in the Index Table. Keys are never
   * removed, so this index is stable for the lifetime of the key and can be
   * used to address the key's version cell.
   */
  lookupIndex(key: string): number | null {
    const view = this.indexTable.getView();
    const count = view.getInt32(0, true);
    for (let i = 0; i < count; i++) {
      const entryOffset = INDEX_HEADER + i * INDEX_ENTRY_SIZE;
      const keyOffset = view.getInt32(entryOffset, true);
      const keyLength = view.getInt32(entryOffset + 4, true);
      const storedKey = this.readString({ offset: keyOffset, length: keyLength });
      if (storedKey === key) {
        return i;
      }
    }
    return null;
  }

  /** Read the current version for a key index (lock-free). */
  getVersion(index: number): number {
    return Atomics.load(this.versionView, index);
  }

  /** Increment the version for a key index, invalidating read caches. */
  bumpVersion(index: number): void {
    Atomics.add(this.versionView, index, 1);
  }

  /** Insert a key → dataOffset mapping into the Index Table. */
  insert(key: string, dataOffset: number): void {
    const keyRef = this.storeString(key);
    const view = this.indexTable.getView();
    const count = view.getInt32(0, true);
    const entryOffset = INDEX_HEADER + count * INDEX_ENTRY_SIZE;
    this.indexTable.ensureCapacity(entryOffset + INDEX_ENTRY_SIZE);
    view.setInt32(entryOffset, keyRef.offset, true);
    view.setInt32(entryOffset + 4, keyRef.length, true);
    view.setInt32(entryOffset + 8, dataOffset, true);
    view.setInt32(0, count + 1, true);
    this.indexTable.advance(INDEX_ENTRY_SIZE);

    // Initialize the new key's version cell to 0.
    const versionOffset = count * Int32Array.BYTES_PER_ELEMENT;
    this.versionTable.ensureCapacity(versionOffset + Int32Array.BYTES_PER_ELEMENT);
    // Rebuild the view if the buffer grew (grow preserves the SAB in place).
    this.versionView = new Int32Array(this.versionTable.buffer);
    Atomics.store(this.versionView, count, 0);
    this.versionTable.advance(Int32Array.BYTES_PER_ELEMENT);
  }
}

function writeSlot(view: DataView, offset: number, slot: ValueSlot): void {
  view.setInt32(offset, slot.type, true);
  view.setInt32(offset + 4, slot.a, true);
  view.setInt32(offset + 8, slot.b, true);
  view.setInt32(offset + 12, slot.c, true);
}

function readSlot(view: DataView, offset: number): ValueSlot {
  return {
    type: view.getInt32(offset, true),
    a: view.getInt32(offset + 4, true),
    b: view.getInt32(offset + 8, true),
    c: view.getInt32(offset + 12, true),
  };
}
