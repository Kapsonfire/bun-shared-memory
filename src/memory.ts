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
}

export interface ValueSlot {
  type: number;
  a: number;
  b: number;
  c: number;
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
  return { type: TYPE_ARRAY_REF, a: ref.offset, b: ref.count, c: 0 };
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
      return { offset: slot.a, count: slot.b };
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
  /** Cross-worker mutex protecting all read/write operations. */
  readonly lock: Mutex;

  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(options?: {
    initialSize?: number;
    maxByteLength?: number;
    lock?: Mutex;
  }) {
    const initial = options?.initialSize ?? DEFAULT_INITIAL;
    const max = options?.maxByteLength ?? DEFAULT_MAX;
    this.indexTable = new GrowableBuffer(initial, max);
    this.dataTable = new GrowableBuffer(initial, max);
    this.stringTable = new GrowableBuffer(initial, max);
    this.arrayTable = new GrowableBuffer(initial, max);
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

  /** Append an array of value slots to the ArrayTable and return its reference. */
  storeArray(slots: ValueSlot[]): ArrayRef {
    const offset = this.arrayTable.byteLength / SLOT_SIZE;
    const count = slots.length;
    this.arrayTable.ensureCapacity((offset + count) * SLOT_SIZE);
    const view = this.arrayTable.getView();
    for (let i = 0; i < count; i++) {
      writeSlot(view, (offset + i) * SLOT_SIZE, slots[i]!);
    }
    this.arrayTable.advance(count * SLOT_SIZE);
    return { offset, count };
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
    const view = this.indexTable.getView();
    const count = view.getInt32(0, true);
    for (let i = 0; i < count; i++) {
      const entryOffset = INDEX_HEADER + i * INDEX_ENTRY_SIZE;
      const keyOffset = view.getInt32(entryOffset, true);
      const keyLength = view.getInt32(entryOffset + 4, true);
      const storedKey = this.readString({ offset: keyOffset, length: keyLength });
      if (storedKey === key) {
        return view.getInt32(entryOffset + 8, true);
      }
    }
    return null;
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
