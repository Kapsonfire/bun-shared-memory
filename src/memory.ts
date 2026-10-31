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
 *   [0..3]   type (Int32): 0=number, 1=boolean, 2=bigint, 3=string-ref, 4=array-ref
 *   [4..7]   payload A
 *   [8..11]  payload B
 *   [12..15] payload C
 *
 *   number     -> float64 in [4..11]
 *   boolean    -> [4] = 0/1
 *   bigint     -> int64 in [4..11]
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

const SLOT_SIZE = 16;
const OBJECT_HEADER = 16;
const NAME_REF_SIZE = 8;
const INDEX_ENTRY_SIZE = 12;
const INDEX_HEADER = 4;

const DEFAULT_INITIAL = 1024;
const DEFAULT_MAX = 64 * 1024 * 1024; // 64 MiB

export interface StringRef {
  offset: number;
  length: number;
}

export interface ArrayRef {
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
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  const dv = new DataView(buf);
  return { type: TYPE_NUMBER, a: dv.getInt32(0, true), b: dv.getInt32(4, true), c: 0 };
}

/** Encode a boolean into a ValueSlot. */
export function booleanSlot(value: boolean): ValueSlot {
  return { type: TYPE_BOOLEAN, a: value ? 1 : 0, b: 0, c: 0 };
}

/** Encode a bigint (int64) into a ValueSlot. */
export function bigintSlot(value: bigint): ValueSlot {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, value, true);
  const dv = new DataView(buf);
  return { type: TYPE_BIGINT, a: dv.getInt32(0, true), b: dv.getInt32(4, true), c: 0 };
}

/** Encode a string reference into a ValueSlot. */
export function stringRefSlot(ref: StringRef): ValueSlot {
  return { type: TYPE_STRING_REF, a: ref.offset, b: ref.length, c: 0 };
}

/** Encode an array reference into a ValueSlot. */
export function arrayRefSlot(ref: ArrayRef): ValueSlot {
  return { type: TYPE_ARRAY_REF, a: ref.offset, b: ref.count, c: ref.capacity };
}

/** Decode a ValueSlot into a JS value (primitives) or a ref object. */
export function decodeSlot(slot: ValueSlot): unknown {
  switch (slot.type) {
    case TYPE_NUMBER: {
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setInt32(0, slot.a, true);
      dv.setInt32(4, slot.b, true);
      return dv.getFloat64(0, true);
    }
    case TYPE_BOOLEAN:
      return slot.a === 1;
    case TYPE_BIGINT: {
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setInt32(0, slot.a, true);
      dv.setInt32(4, slot.b, true);
      return dv.getBigInt64(0, true);
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

  constructor(options?: {
    initialSize?: number;
    maxByteLength?: number;
    lock?: Mutex;
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
  }

  /** Run `fn` while holding the shared lock. */
  withLock<T>(fn: () => T): T {
    return this.lock.withLock(fn);
  }

  // ---------------------------------------------------------------------------
  // StringTable
  // ---------------------------------------------------------------------------

  /** Append a string to the StringTable and return its reference. */
  storeString(value: string): StringRef {
    const bytes = this.encoder.encode(value);
    const offset = this.stringTable.byteLength;
    this.stringTable.ensureCapacity(offset + bytes.byteLength);
    const view = this.stringTable.getView();
    for (let i = 0; i < bytes.byteLength; i++) {
      view.setUint8(offset + i, bytes[i]!);
    }
    this.stringTable.advance(bytes.byteLength);
    return { offset, length: bytes.byteLength };
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
   * `capacity` is the number of slots reserved for the array (>= slots.length).
   * The extra slots are padding so `push` can grow the array in place without
   * overwriting the next array. When the padding is exhausted, the array must
   * be moved (see `moveArray`).
   */
  storeArray(slots: ValueSlot[], capacity?: number): ArrayRef {
    const count = slots.length;
    const cap = Math.max(capacity ?? count, 1);
    const offset = this.arrayTable.byteLength / SLOT_SIZE;
    this.arrayTable.ensureCapacity((offset + cap) * SLOT_SIZE);
    const view = this.arrayTable.getView();
    for (let i = 0; i < count; i++) {
      writeSlot(view, (offset + i) * SLOT_SIZE, slots[i]!);
    }
    this.arrayTable.advance(cap * SLOT_SIZE);
    return { offset, count, capacity: cap };
  }

  /** Read an array of value slots from the ArrayTable by reference. */
  readArray(ref: ArrayRef): ValueSlot[] {
    const view = this.arrayTable.getView();
    const slots: ValueSlot[] = [];
    for (let i = 0; i < ref.count; i++) {
      slots.push(readSlot(view, (ref.offset + i) * SLOT_SIZE));
    }
    return slots;
  }

  /** Update a single value slot of an array in the ArrayTable in place. */
  updateArraySlot(ref: ArrayRef, index: number, slot: ValueSlot): void {
    writeSlot(this.arrayTable.getView(), (ref.offset + index) * SLOT_SIZE, slot);
  }

  /** Read a single value slot of an array from the ArrayTable. */
  readArraySlot(ref: ArrayRef, index: number): ValueSlot {
    return readSlot(this.arrayTable.getView(), (ref.offset + index) * SLOT_SIZE);
  }

  /**
   * Move an array to a new location with a larger capacity, copying its slots.
   * Returns the new reference. The caller must update the array-ref slot in
   * the DataTable to point at the new location.
   */
  moveArray(ref: ArrayRef, newCapacity: number): ArrayRef {
    const newOffset = this.arrayTable.byteLength / SLOT_SIZE;
    this.arrayTable.ensureCapacity((newOffset + newCapacity) * SLOT_SIZE);
    const view = this.arrayTable.getView();
    for (let i = 0; i < ref.count; i++) {
      writeSlot(view, (newOffset + i) * SLOT_SIZE, readSlot(view, (ref.offset + i) * SLOT_SIZE));
    }
    this.arrayTable.advance(newCapacity * SLOT_SIZE);
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
      writeSlot(this.arrayTable.getView(), (ref.offset + ref.count) * SLOT_SIZE, slot);
      return { offset: ref.offset, count: ref.count + 1, capacity: ref.capacity };
    }
    const moved = this.moveArray(ref, Math.max(ref.capacity * 2, 1));
    writeSlot(this.arrayTable.getView(), (moved.offset + moved.count) * SLOT_SIZE, slot);
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

    view.setInt32(offset, TYPE_OBJECT, true);
    view.setInt32(offset + 4, properties.length, true);

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
    const view = this.indexTable.getView();
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
