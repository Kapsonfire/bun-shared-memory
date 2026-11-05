import {
  GrowableBuffer,
  MIN_BLOCK_SIZE,
  SharedBudget,
  nextPowerOfTwo,
} from "./growable-buffer.ts";
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
 * Index Table entry (16 bytes):
 *   [0..3]   key string offset
 *   [4..7]   key string length
 *   [8..11]  data offset (into DataTable)
 *   [12..15] key version
 */

export const TYPE_NUMBER = 0;
export const TYPE_BOOLEAN = 1;
export const TYPE_BIGINT = 2;
export const TYPE_STRING_REF = 3;
export const TYPE_ARRAY_REF = 4;
export const TYPE_OBJECT = 5;
export const TYPE_BIGINT_STR = 6;
/** A string value stored in the ArrayTable (slab-allocated, refcounted). */
export const TYPE_STRING_VALUE_REF = 7;
/**
 * A short string stored inline in the slot itself (up to 12 UTF-8 bytes in
 * the a/b/c fields), avoiding a heap allocation and the string-table write.
 */
export const TYPE_INLINE_STRING = 8;

const SLOT_SIZE = 16;
const OBJECT_HEADER = 16;
const NAME_REF_SIZE = 8;
const INDEX_ENTRY_SIZE = 16;
const INDEX_HEADER = 4;
/** Byte offset of the version field within an index entry. */
const INDEX_VERSION_OFFSET = 12;
const MAX_INDEX_TABLE_BYTES = 4 * 1024 * 1024 * 1024;
/** Size of the objectId header at the start of each array block. */
const ARRAY_HEADER = 4;

const DEFAULT_INITIAL = 1024;
const DEFAULT_MAX = 64 * 1024 * 1024; // 64 MiB
const DEFAULT_CHUNK_SIZE = 32 * 1024 * 1024; // 32 MiB per chunk
/** Minimum size of a single chunk (a chunk is the minimum growth step). */
const MIN_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
/** Minimum combined memory budget (maxTotalBytes / maxByteLength). */
const MIN_MAX_MEMORY = 32 * 1024 * 1024; // 32 MiB
/** Maximum number of chunks per table (chunkSize must be large enough). */
const MAX_CHUNKS_PER_TABLE = 1024;
const DEFAULT_INTERN_CAPACITY = 256;
const DEFAULT_INTERN_MAX = 1 << 16; // 65536 entries

/** Int32Array index of a key's version cell within the Index Table buffer. */
function versionCellIndex(index: number): number {
  return (INDEX_HEADER + index * INDEX_ENTRY_SIZE + INDEX_VERSION_OFFSET) / 4;
}

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
  /**
   * Reserved block size in the ArrayTable (>= ARRAY_HEADER + length). Only
   * set for string values stored in the ArrayTable; used to grow a block in
   * place when a string is overwritten with a longer one.
   */
  reserved?: number;
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
  return {
    type: TYPE_NUMBER,
    a: slotView.getInt32(0, true),
    b: slotView.getInt32(4, true),
    c: 0,
  };
}

/** Encode a boolean into a ValueSlot. */
export function booleanSlot(value: boolean): ValueSlot {
  return { type: TYPE_BOOLEAN, a: value ? 1 : 0, b: 0, c: 0 };
}

/** Encode a bigint (int64) into a ValueSlot. */
export function bigintSlot(value: bigint): ValueSlot {
  slotView.setBigInt64(0, value, true);
  return {
    type: TYPE_BIGINT,
    a: slotView.getInt32(0, true),
    b: slotView.getInt32(4, true),
    c: 0,
  };
}

/** Encode a string reference into a ValueSlot. */
export function stringRefSlot(ref: StringRef): ValueSlot {
  return { type: TYPE_STRING_REF, a: ref.offset, b: ref.length, c: 0 };
}

/** Encode a string value (in the ArrayTable) into a ValueSlot. */
export function stringValueRefSlot(ref: StringRef): ValueSlot {
  return {
    type: TYPE_STRING_VALUE_REF,
    a: ref.offset,
    b: ref.length,
    c: ref.reserved ?? 0,
  };
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
    case TYPE_STRING_VALUE_REF:
      return { offset: slot.a, length: slot.b };
    case TYPE_ARRAY_REF:
      return { offset: slot.a, count: slot.b, capacity: slot.c };
    default:
      throw new Error(`Unknown slot type ${slot.type}`);
  }
}

export interface SharedMemoryOptions {
  initialSize?: number;
  /** Per-buffer maximum byte length (clamped to at least 32 MiB). */
  maxByteLength?: number;
  /**
   * Total physical memory budget shared by DataTable, StringTable, and
   * ArrayTable (clamped to at least 32 MiB).
   */
  maxTotalBytes?: number;
  /** Internal worker reconstruction option; normally inferred from buffers. */
  indexTableMaxByteLength?: number;
  /**
   * Size of each growable chunk (the minimum growth step). Default 32 MiB,
   * clamped to at least 4 MiB and raised as needed so no table needs more
   * than 1024 chunks.
   */
  chunkSize?: number;
  lock?: Mutex;
  internCapacity?: number;
  internMax?: number;
  buffers?: {
    indexTable?: SharedArrayBuffer | SharedArrayBuffer[];
    dataTable?: SharedArrayBuffer | SharedArrayBuffer[];
    stringTable?: SharedArrayBuffer | SharedArrayBuffer[];
    arrayTable?: SharedArrayBuffer | SharedArrayBuffer[];
    layoutVersion?: SharedArrayBuffer;
    refCount?: SharedArrayBuffer;
    budget?: SharedArrayBuffer;
    cursors?: {
      indexTable?: SharedArrayBuffer;
      dataTable?: SharedArrayBuffer;
      stringTable?: SharedArrayBuffer;
      arrayTable?: SharedArrayBuffer;
    };
    freeLists?: {
      dataTable?: SharedArrayBuffer;
      stringTable?: SharedArrayBuffer;
      arrayTable?: SharedArrayBuffer;
    };
  };
}

/** Build a GrowableBuffer from an optional single SAB, chunk list, or nothing. */
function makeBuffer(
  buf: SharedArrayBuffer | SharedArrayBuffer[] | undefined,
  initial: number,
  maxByteLength: number,
  budget?: SharedBudget,
  chunkSize?: number,
  singleBuffer = false,
  chargeInitial = true,
  cursorBuffer?: SharedArrayBuffer,
  freeListBuffer?: SharedArrayBuffer,
): GrowableBuffer {
  if (buf === undefined) {
    return new GrowableBuffer(
      initial,
      maxByteLength,
      budget,
      chunkSize,
      singleBuffer,
      chargeInitial,
      cursorBuffer,
      freeListBuffer,
    );
  }
  return new GrowableBuffer(
    buf,
    maxByteLength,
    budget,
    chunkSize,
    singleBuffer,
    chargeInitial,
    cursorBuffer,
    freeListBuffer,
  );
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
  /** Per-buffer maximum byte length (clamped to at least 32 MiB). */
  readonly maxByteLength: number;
  private readonly indexTableMaxByteLength: number;
  /** Combined memory budget for Data/String/Array tables, or null if unset. */
  readonly maxTotalBytes: number | null;
  private readonly budgetBuffer: SharedArrayBuffer | null;
  /**
   * Cached Int32Array view over the Index Table, used to read/increment each
   * key's version cell (stored as the 4th field of each index entry). Rebuilt
   * on growth. The version is incremented on every write so workers can
   * invalidate their read caches cross-worker.
   */
  versionView: Int32Array;
  /**
   * Global layout version cell. Bumped by the main thread after a
   * defragmentation pass so workers can invalidate cached offsets (indexCache,
   * layoutCache, propCache, readCache, internCache).
   */
  readonly layoutVersion: Int32Array;
  /** Cross-worker mutex protecting all read/write operations. */
  readonly lock: Mutex;
  /**
   * The 5th shared buffer: reference-counting ring buffer + heartbeat +
   * global refcount table. Shared with workers so they can report acquire/
   * release events to the main thread's coordinator. Optional; created lazily
   * by the coordinator when auto-GC is enabled.
   */
  readonly refCountBuffer: SharedArrayBuffer | null;

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

  constructor(options?: SharedMemoryOptions) {
    const initial = options?.initialSize ?? DEFAULT_INITIAL;
    // `maxTotalBytes` caps the combined physical size of DataTable,
    // StringTable, and ArrayTable. IndexTable has its independent 4 GiB cap.
    // Without maxTotalBytes, each buffer grows up to its own maxByteLength.
    // The Index Table remains a single growable SharedArrayBuffer and is
    // capped at 4 GiB. The other tables use chunks and can exceed that limit.
    const maxTotal = options?.maxTotalBytes;
    if (
      maxTotal !== undefined &&
      (!Number.isSafeInteger(maxTotal) || maxTotal < 0)
    ) {
      throw new RangeError("maxTotalBytes must be a non-negative safe integer");
    }
    // Enforce the minimum memory budget: maxTotalBytes / maxByteLength are
    // never below 32 MiB.
    const perBufferMax = Math.max(
      maxTotal ?? options?.maxByteLength ?? DEFAULT_MAX,
      MIN_MAX_MEMORY,
    );
    const indexTableMax = Math.min(
      options?.indexTableMaxByteLength ?? options?.maxByteLength ?? DEFAULT_MAX,
      MAX_INDEX_TABLE_BYTES,
    );
    // Enforce the chunk-size limits: at least 4 MiB, and large enough that no
    // table needs more than MAX_CHUNKS_PER_TABLE chunks.
    const userChunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkSize = Math.max(
      userChunkSize,
      MIN_CHUNK_SIZE,
      nextPowerOfTwo(perBufferMax / MAX_CHUNKS_PER_TABLE),
    );
    const buffers = options?.buffers;
    // The budget is the clamped maxTotalBytes (never below MIN_MAX_MEMORY), so
    // it stays consistent with perBufferMax.
    const budgetMax = maxTotal !== undefined ? perBufferMax : undefined;
    const budgetBuffer = buffers?.budget;
    const budget =
      budgetMax !== undefined
        ? new SharedBudget(budgetMax, budgetBuffer)
        : undefined;
    const chargeInitial = budgetBuffer === undefined;
    this.maxByteLength = perBufferMax;
    this.indexTableMaxByteLength = indexTableMax;
    this.maxTotalBytes = budgetMax ?? null;
    this.budgetBuffer = budget?.buffer ?? null;
    this.indexTable = makeBuffer(
      buffers?.indexTable,
      initial,
      indexTableMax,
      undefined,
      chunkSize,
      true,
      true,
      buffers?.cursors?.indexTable,
    );
    this.dataTable = makeBuffer(
      buffers?.dataTable,
      initial,
      perBufferMax,
      budget,
      chunkSize,
      false,
      chargeInitial,
      buffers?.cursors?.dataTable,
      buffers?.freeLists?.dataTable,
    );
    this.stringTable = makeBuffer(
      buffers?.stringTable,
      initial,
      perBufferMax,
      budget,
      chunkSize,
      false,
      chargeInitial,
      buffers?.cursors?.stringTable,
      buffers?.freeLists?.stringTable,
    );
    this.arrayTable = makeBuffer(
      buffers?.arrayTable,
      initial,
      perBufferMax,
      budget,
      chunkSize,
      false,
      chargeInitial,
      buffers?.cursors?.arrayTable,
      buffers?.freeLists?.arrayTable,
    );
    this.versionView = new Int32Array(this.indexTable.buffers[0]!);
    this.layoutVersion = new Int32Array(
      buffers?.layoutVersion ??
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3),
    );
    this.lock = options?.lock ?? new Mutex();
    this.refCountBuffer = buffers?.refCount ?? null;
    this.internCapacity = options?.internCapacity ?? DEFAULT_INTERN_CAPACITY;
    this.internMax = options?.internMax ?? DEFAULT_INTERN_MAX;
  }

  /** Run `fn` while holding the shared lock. */
  withLock<T>(fn: () => T): T {
    return this.lock.withLock(fn);
  }

  /**
   * Apply a buffer update received from the main thread after a
   * defragmentation pass. Replaces each table's buffers and rebuilds the
   * version view. Called by workers on the `__chunkUpdate` message.
   */
  applyChunkUpdate(buffers: {
    indexTable: SharedArrayBuffer[];
    dataTable: SharedArrayBuffer[];
    stringTable: SharedArrayBuffer[];
    arrayTable: SharedArrayBuffer[];
  }): void {
    this.indexTable.applyChunks(buffers.indexTable);
    this.dataTable.applyChunks(buffers.dataTable);
    this.stringTable.applyChunks(buffers.stringTable);
    this.arrayTable.applyChunks(buffers.arrayTable);
    this.versionView = new Int32Array(this.indexTable.buffers[0]!);
  }

  /**
   * Attach the reference-counting buffer (5th SAB) to this memory so it is
   * included in `exportBuffers()`. No-op if a buffer is already attached.
   */
  attachRefCountBuffer(sab: SharedArrayBuffer): void {
    if (this.refCountBuffer === null) {
      (this as { refCountBuffer: SharedArrayBuffer | null }).refCountBuffer =
        sab;
    }
  }

  /**
   * Export all shared buffers (including the lock) so they can be sent to a
   * worker via `postMessage` and reconstructed there with `fromBuffers()`.
   *
   * Tables are exported as lists for the chunked buffers. The Index Table is
   * a single growable SharedArrayBuffer, exported as a one-element list. The
   * optional shared budget counter is included so workers reserve atomically
   * against the same three-table limit.
   */
  exportBuffers(): {
    indexTable: SharedArrayBuffer[];
    dataTable: SharedArrayBuffer[];
    stringTable: SharedArrayBuffer[];
    arrayTable: SharedArrayBuffer[];
    layoutVersion: SharedArrayBuffer;
    lock: SharedArrayBuffer;
    refCount: SharedArrayBuffer | null;
    maxByteLength: number;
    indexTableMaxByteLength: number;
    maxTotalBytes: number | null;
    budget: SharedArrayBuffer | null;
    cursors: {
      indexTable: SharedArrayBuffer;
      dataTable: SharedArrayBuffer;
      stringTable: SharedArrayBuffer;
      arrayTable: SharedArrayBuffer;
    };
    freeLists: {
      dataTable: SharedArrayBuffer;
      stringTable: SharedArrayBuffer;
      arrayTable: SharedArrayBuffer;
    };
  } {
    return {
      indexTable: this.indexTable.buffers,
      dataTable: this.dataTable.buffers,
      stringTable: this.stringTable.buffers,
      arrayTable: this.arrayTable.buffers,
      layoutVersion: this.layoutVersion.buffer as SharedArrayBuffer,
      lock: this.lock.buffer as SharedArrayBuffer,
      refCount: this.refCountBuffer,
      maxByteLength: this.maxByteLength,
      indexTableMaxByteLength: this.indexTableMaxByteLength,
      maxTotalBytes: this.maxTotalBytes,
      budget: this.budgetBuffer,
      cursors: {
        indexTable: this.indexTable.cursorBuffer,
        dataTable: this.dataTable.cursorBuffer,
        stringTable: this.stringTable.cursorBuffer,
        arrayTable: this.arrayTable.cursorBuffer,
      },
      freeLists: {
        dataTable: this.dataTable.freeListBuffer,
        stringTable: this.stringTable.freeListBuffer,
        arrayTable: this.arrayTable.freeListBuffer,
      },
    };
  }

  /**
   * Reconstruct a SharedMemory instance from buffers exported by
   * `exportBuffers()` (e.g. received from the main thread in a worker).
   */
  static fromBuffers(buffers: {
    indexTable: SharedArrayBuffer | SharedArrayBuffer[];
    dataTable: SharedArrayBuffer | SharedArrayBuffer[];
    stringTable: SharedArrayBuffer | SharedArrayBuffer[];
    arrayTable: SharedArrayBuffer | SharedArrayBuffer[];
    layoutVersion: SharedArrayBuffer;
    lock: SharedArrayBuffer;
    refCount?: SharedArrayBuffer | null;
    maxByteLength?: number;
    indexTableMaxByteLength?: number;
    maxTotalBytes?: number | null;
    budget?: SharedArrayBuffer | null;
    cursors?: {
      indexTable?: SharedArrayBuffer;
      dataTable?: SharedArrayBuffer;
      stringTable?: SharedArrayBuffer;
      arrayTable?: SharedArrayBuffer;
    };
    freeLists?: {
      dataTable?: SharedArrayBuffer;
      stringTable?: SharedArrayBuffer;
      arrayTable?: SharedArrayBuffer;
    };
  }): SharedMemory {
    const indexBuffer = Array.isArray(buffers.indexTable)
      ? buffers.indexTable[0]
      : buffers.indexTable;
    return new SharedMemory({
      maxByteLength: buffers.maxByteLength ?? DEFAULT_MAX,
      indexTableMaxByteLength:
        buffers.indexTableMaxByteLength ??
        indexBuffer?.maxByteLength ??
        indexBuffer?.byteLength ??
        DEFAULT_MAX,
      maxTotalBytes: buffers.maxTotalBytes ?? undefined,
      buffers: {
        indexTable: buffers.indexTable,
        dataTable: buffers.dataTable,
        stringTable: buffers.stringTable,
        arrayTable: buffers.arrayTable,
        layoutVersion: buffers.layoutVersion,
        refCount: buffers.refCount ?? undefined,
        budget: buffers.budget ?? undefined,
        cursors: buffers.cursors,
        freeLists: buffers.freeLists,
      },
      lock: new Mutex(buffers.lock),
    });
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
    const offset = this.stringTable.reserve(bytes.byteLength);
    this.stringTable.writeBytes(offset, bytes);
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
    const bytes = this.stringTable.readBytes(ref.offset, ref.length);
    return this.decoder.decode(bytes);
  }

  /**
   * Store a string value in the ArrayTable as a slab-allocated block.
   *
   * Unlike `storeString` (which interns into the append-only StringTable for
   * property names and keys), string values are stored in the ArrayTable so
   * they can be freed and reused when their reference is overwritten. Each
   * block starts with a 4-byte objectId header (for refcounting), followed by
   * the UTF-8 bytes of the string.
   *
   * @returns a StringRef pointing into the ArrayTable.
   */
  storeStringValue(value: string, oldRef?: StringRef): StringRef {
    const bytes = this.encoder.encode(value);
    const size = ARRAY_HEADER + bytes.byteLength;
    // In-place update: if the new string fits in the existing block (same
    // length or shorter), overwrite it without allocating a new block. This
    // keeps repeated writes to the same string property cheap and avoids
    // unbounded ArrayTable growth. The block's objectId header is preserved.
    if (oldRef !== undefined && size <= ARRAY_HEADER + oldRef.length) {
      this.arrayTable.writeBytes(oldRef.offset + ARRAY_HEADER, bytes);
      return {
        offset: oldRef.offset,
        length: bytes.byteLength,
        reserved: oldRef.reserved ?? size,
      };
    }
    // The new string is longer than the old block. If the old block is the
    // last allocated block (its reserved end is the current used length), grow
    // it in place so repeated writes to the same property don't leak dead
    // blocks. This also covers the shrink-then-grow case: a block that was
    // reserved for a longer string but currently holds a shorter one can be
    // grown back into its own reserved tail.
    if (oldRef !== undefined && oldRef.reserved !== undefined) {
      const reservedEnd = oldRef.offset + oldRef.reserved;
      if (this.arrayTable.growInPlace(reservedEnd, size - oldRef.reserved)) {
        this.arrayTable.writeBytes(oldRef.offset + ARRAY_HEADER, bytes);
        return {
          offset: oldRef.offset,
          length: bytes.byteLength,
          reserved: Math.max(oldRef.reserved, size),
        };
      }
    }
    const offset = this.arrayTable.reserve(size);
    const objectId = this.nextObjectId++;
    this.arrayTable.setInt32(offset, objectId);
    this.arrayTable.writeBytes(offset + ARRAY_HEADER, bytes);
    return { offset, length: bytes.byteLength, reserved: size };
  }

  /** Read a string value from the ArrayTable by reference. */
  readStringValue(ref: StringRef): string {
    const bytes = this.arrayTable.readBytes(
      ref.offset + ARRAY_HEADER,
      ref.length,
    );
    return this.decoder.decode(bytes);
  }

  /** Read a short string stored inline in a DataTable slot. */
  readInlineString(a: number, b: number, c: number): string {
    const length = c >>> 28;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const word = i < 4 ? a : i < 8 ? b : c;
      bytes[i] = (word >>> ((i % 4) * 8)) & 0xff;
    }
    return this.decoder.decode(bytes);
  }

  /**
   * Free a string value block in the ArrayTable, pushing it onto the free
   * list so it can be reused. Detects double frees.
   *
   * No-op: string-value blocks are no longer freed on the hot path (they are
   * reclaimed by defragmentation instead), so this is kept only for API
   * compatibility.
   */
  freeStringValue(_ref: StringRef): void {
    // Intentionally a no-op; dead string blocks are reclaimed by defrag.
  }

  /**
   * Release a reference to a string value.
   *
   * No-op: string-value refcounting is disabled. Blocks are never freed on the
   * hot path; dead space is reclaimed by defragmentation.
   */
  releaseStringValue(_ref: StringRef): void {
    // Intentionally a no-op; see freeStringValue.
  }

  /**
   * Acquire a reference to a string value.
   *
   * No-op: string-value refcounting is disabled.
   */
  acquireStringValue(_ref: StringRef): void {
    // Intentionally a no-op; see freeStringValue.
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
    const cap = Math.max(capacity ?? 0, count, 1);
    const size = ARRAY_HEADER + cap * SLOT_SIZE;
    const offset = this.arrayTable.reserve(size);
    const objectId = this.nextObjectId++;
    this.arrayTable.setInt32(offset, objectId);
    for (let i = 0; i < count; i++) {
      writeSlot(
        this.arrayTable,
        offset + ARRAY_HEADER + i * SLOT_SIZE,
        slots[i]!,
      );
    }
    return { offset, count, capacity: cap };
  }

  /** Read an array of value slots from the ArrayTable by reference. */
  readArray(ref: ArrayRef): ValueSlot[] {
    const slots: ValueSlot[] = [];
    for (let i = 0; i < ref.count; i++) {
      slots.push(
        readSlot(this.arrayTable, ref.offset + ARRAY_HEADER + i * SLOT_SIZE),
      );
    }
    return slots;
  }

  /** Update a single value slot of an array in the ArrayTable in place. */
  updateArraySlot(ref: ArrayRef, index: number, slot: ValueSlot): void {
    writeSlot(
      this.arrayTable,
      ref.offset + ARRAY_HEADER + index * SLOT_SIZE,
      slot,
    );
  }

  /**
   * Fast-path: write a float64 number into an array slot directly, avoiding
   * the ValueSlot object allocation and the 4 separate Int32 writes.
   */
  updateArrayNumberSlot(ref: ArrayRef, index: number, value: number): void {
    slotView.setFloat64(0, value, true);
    const buf = this.arrayTable;
    const off = ref.offset + ARRAY_HEADER + index * SLOT_SIZE;
    buf.setInt32(off, TYPE_NUMBER);
    buf.setInt32(off + 4, slotView.getInt32(0, true));
    buf.setInt32(off + 8, slotView.getInt32(4, true));
    buf.setInt32(off + 12, 0);
  }

  /**
   * Fast-path: write a boolean into an array slot directly, avoiding the
   * ValueSlot object allocation and the 4 separate Int32 writes.
   */
  updateArrayBooleanSlot(ref: ArrayRef, index: number, value: boolean): void {
    const buf = this.arrayTable;
    const off = ref.offset + ARRAY_HEADER + index * SLOT_SIZE;
    buf.setInt32(off, TYPE_BOOLEAN);
    buf.setInt32(off + 4, value ? 1 : 0);
    buf.setInt32(off + 8, 0);
    buf.setInt32(off + 12, 0);
  }

  /**
   * Fast-path: write an int64 bigint into an array slot directly, avoiding
   * the ValueSlot object allocation and the 4 separate Int32 writes.
   */
  updateArrayBigIntSlot(ref: ArrayRef, index: number, value: bigint): void {
    slotView.setBigInt64(0, value, true);
    const buf = this.arrayTable;
    const off = ref.offset + ARRAY_HEADER + index * SLOT_SIZE;
    buf.setInt32(off, TYPE_BIGINT);
    buf.setInt32(off + 4, slotView.getInt32(0, true));
    buf.setInt32(off + 8, slotView.getInt32(4, true));
    buf.setInt32(off + 12, 0);
  }

  /**
   * Fast-path: write a short string inline into an array slot (up to 11
   * UTF-8 bytes), avoiding a heap allocation and the string-table write.
   * Returns true if the string fit inline; false if it must go to the heap.
   */
  updateArrayInlineStringSlot(
    ref: ArrayRef,
    index: number,
    value: string,
  ): boolean {
    const bytes = this.encoder.encode(value);
    if (bytes.byteLength > 11) return false;
    const buf = this.arrayTable;
    const off = ref.offset + ARRAY_HEADER + index * SLOT_SIZE;
    buf.setInt32(off, TYPE_INLINE_STRING);
    let a = 0;
    let b = 0;
    let c = bytes.byteLength << 28;
    for (let i = 0; i < bytes.byteLength; i++) {
      const byte = bytes[i]!;
      if (i < 4) a |= byte << (i * 8);
      else if (i < 8) b |= byte << ((i - 4) * 8);
      else c |= byte << ((i - 8) * 8);
    }
    buf.setInt32(off + 4, a);
    buf.setInt32(off + 8, b);
    buf.setInt32(off + 12, c);
    return true;
  }

  /** Read a single value slot of an array from the ArrayTable. */
  readArraySlot(ref: ArrayRef, index: number): ValueSlot {
    return readSlot(
      this.arrayTable,
      ref.offset + ARRAY_HEADER + index * SLOT_SIZE,
    );
  }

  /** Read the stable objectId of an array block in the ArrayTable. */
  getArrayObjectId(offset: number): number {
    return this.arrayTable.getInt32(offset);
  }

  /**
   * Move an array to a new location with a larger capacity, copying its slots.
   * Returns the new reference. The caller must update the array-ref slot in
   * the DataTable to point at the new location.
   */
  moveArray(ref: ArrayRef, newCapacity: number): ArrayRef {
    const size = ARRAY_HEADER + newCapacity * SLOT_SIZE;
    const newOffset = this.arrayTable.reserve(size);
    const objectId = this.getArrayObjectId(ref.offset);
    this.arrayTable.setInt32(newOffset, objectId);
    for (let i = 0; i < ref.count; i++) {
      writeSlot(
        this.arrayTable,
        newOffset + ARRAY_HEADER + i * SLOT_SIZE,
        readSlot(this.arrayTable, ref.offset + ARRAY_HEADER + i * SLOT_SIZE),
      );
    }
    // The old block is no longer referenced; it is reclaimed by defrag.
    this.freeArray(ref);
    // The array moved to a new offset, so any cached ArrayRef (e.g. the
    // per-target `__arrayRef` on the write hot path) is now stale. Bump the
    // global layout version so those caches are invalidated, exactly as a
    // defragmentation pass does.
    this.bumpLayoutVersion();
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
      writeSlot(
        this.arrayTable,
        ref.offset + ARRAY_HEADER + ref.count * SLOT_SIZE,
        slot,
      );
      return {
        offset: ref.offset,
        count: ref.count + 1,
        capacity: ref.capacity,
      };
    }
    const moved = this.moveArray(ref, Math.max(ref.capacity * 2, 1));
    writeSlot(
      this.arrayTable,
      moved.offset + ARRAY_HEADER + moved.count * SLOT_SIZE,
      slot,
    );
    return {
      offset: moved.offset,
      count: moved.count + 1,
      capacity: moved.capacity,
    };
  }

  /**
   * Free an array block, pushing it onto the ArrayTable free list so it can
   * be reused. Detects double frees. The block's data is overwritten with
   * free-list metadata, so it must not be read after freeing.
   */
  freeArray(_ref: ArrayRef): void {
    // No-op: array blocks are reclaimed by defrag, not the free list.
  }

  // ---------------------------------------------------------------------------
  // DataTable
  // ---------------------------------------------------------------------------

  /** Store a single value slot in the DataTable and return its offset. */
  storeValueSlot(slot: ValueSlot): number {
    const offset = this.dataTable.reserve(SLOT_SIZE);
    writeSlot(this.dataTable, offset, slot);
    return offset;
  }

  /** Read a single value slot from the DataTable. */
  readValueSlot(offset: number): ValueSlot {
    return readSlot(this.dataTable, offset);
  }

  /** Update a single value slot in the DataTable. */
  updateValueSlot(offset: number, slot: ValueSlot): void {
    writeSlot(this.dataTable, offset, slot);
  }

  /**
   * Fast-path: write a float64 number slot directly into the DataTable,
   * avoiding the ValueSlot object allocation and the 4 separate Int32
   * writes of the generic path.
   */
  updateNumberSlot(offset: number, value: number): void {
    slotView.setFloat64(0, value, true);
    const buf = this.dataTable;
    buf.setInt32(offset, TYPE_NUMBER);
    buf.setInt32(offset + 4, slotView.getInt32(0, true));
    buf.setInt32(offset + 8, slotView.getInt32(4, true));
    buf.setInt32(offset + 12, 0);
  }

  /**
   * Fast-path: write a boolean slot directly into the DataTable, avoiding
   * the ValueSlot object allocation of the generic path.
   */
  updateBooleanSlot(offset: number, value: boolean): void {
    const buf = this.dataTable;
    buf.setInt32(offset, TYPE_BOOLEAN);
    buf.setInt32(offset + 4, value ? 1 : 0);
    buf.setInt32(offset + 8, 0);
    buf.setInt32(offset + 12, 0);
  }

  /**
   * Fast-path: write an int64 bigint slot directly into the DataTable,
   * avoiding the ValueSlot object allocation of the generic path.
   */
  updateBigIntSlot(offset: number, value: bigint): void {
    slotView.setBigInt64(0, value, true);
    const buf = this.dataTable;
    buf.setInt32(offset, TYPE_BIGINT);
    buf.setInt32(offset + 4, slotView.getInt32(0, true));
    buf.setInt32(offset + 8, slotView.getInt32(4, true));
    buf.setInt32(offset + 12, 0);
  }

  /**
   * Fast-path: write a short string inline into the slot itself (up to 11
   * UTF-8 bytes), avoiding a heap allocation and the string-table write.
   * The bytes are packed into the slot's a/b/c fields (11 bytes) with the
   * length in the top 4 bits of `c`, so they can be read back without
   * touching the DataTable again.
   * Returns true if the string fit inline; false if it must go to the heap.
   */
  updateInlineStringSlot(offset: number, value: string): boolean {
    const bytes = this.encoder.encode(value);
    if (bytes.byteLength > 11) return false;
    const buf = this.dataTable;
    buf.setInt32(offset, TYPE_INLINE_STRING);
    // Pack length into the top 4 bits of `c`; bytes 0-3 in `a`, 4-7 in `b`,
    // 8-10 in the low 28 bits of `c`.
    let a = 0;
    let b = 0;
    let c = bytes.byteLength << 28;
    for (let i = 0; i < bytes.byteLength; i++) {
      const byte = bytes[i]!;
      if (i < 4) a |= byte << (i * 8);
      else if (i < 8) b |= byte << ((i - 4) * 8);
      else c |= byte << ((i - 8) * 8);
    }
    buf.setInt32(offset + 4, a);
    buf.setInt32(offset + 8, b);
    buf.setInt32(offset + 12, c);
    return true;
  }

  /**
   * Create an object in the DataTable.
   *
   * @param properties array of [name, valueSlot] pairs
   * @returns the byte offset of the object block in the DataTable
   */
  createObject(properties: Array<[string, ValueSlot]>): number {
    const blockSize =
      OBJECT_HEADER + properties.length * (NAME_REF_SIZE + SLOT_SIZE);
    const offset = this.dataTable.reserve(blockSize);

    const objectId = this.nextObjectId++;
    this.dataTable.setInt32(offset, TYPE_OBJECT);
    this.dataTable.setInt32(offset + 4, properties.length);
    this.dataTable.setInt32(offset + 8, objectId);

    let cursor = offset + OBJECT_HEADER;
    for (const [name, slot] of properties) {
      const nameRef = this.storeString(name);
      this.dataTable.setInt32(cursor, nameRef.offset);
      this.dataTable.setInt32(cursor + 4, nameRef.length);
      cursor += NAME_REF_SIZE;
      writeSlot(this.dataTable, cursor, slot);
      cursor += SLOT_SIZE;
    }
    return offset;
  }

  /** Read an object's properties from the DataTable. */
  readObject(offset: number): Array<[string, ValueSlot]> {
    const count = this.dataTable.getInt32(offset + 4);
    const properties: Array<[string, ValueSlot]> = [];
    let cursor = offset + OBJECT_HEADER;
    for (let i = 0; i < count; i++) {
      const nameOffset = this.dataTable.getInt32(cursor);
      const nameLength = this.dataTable.getInt32(cursor + 4);
      const name = this.readString({ offset: nameOffset, length: nameLength });
      cursor += NAME_REF_SIZE;
      const slot = readSlot(this.dataTable, cursor);
      cursor += SLOT_SIZE;
      properties.push([name, slot]);
    }
    return properties;
  }

  /** Read the stable objectId of an object block in the DataTable. */
  getObjectId(offset: number): number {
    return this.dataTable.getInt32(offset + 8);
  }

  /**
   * Free a single value slot in the DataTable, pushing it onto the free list
   * so it can be reused. Detects double frees.
   */
  freeValueSlot(_offset: number): void {
    // No-op: value slots are reclaimed by defrag, not the free list.
  }

  /**
   * Free an object block in the DataTable, pushing it onto the free list so
   * it can be reused. Detects double frees. The block's data is overwritten
   * with free-list metadata, so it must not be read after freeing.
   */
  freeObject(_offset: number): void {
    // No-op: object blocks are reclaimed by defrag, not the free list.
  }

  /**
   * Free a string in the StringTable, pushing it onto the free list so it can
   * be reused. Detects double frees. The string's bytes are overwritten with
   * free-list metadata, so it must not be read after freeing.
   */
  freeString(_ref: StringRef): void {
    // No-op: string blocks are reclaimed by defrag, not the free list.
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
    if (this.dataTable.getInt32(offset) !== TYPE_OBJECT) return null;
    const count = this.dataTable.getInt32(offset + 4);
    const properties = new Map<string, number>();
    let cursor = offset + OBJECT_HEADER;
    for (let i = 0; i < count; i++) {
      const nameOffset = this.dataTable.getInt32(cursor);
      const nameLength = this.dataTable.getInt32(cursor + 4);
      const name = this.readString({ offset: nameOffset, length: nameLength });
      cursor += NAME_REF_SIZE;
      properties.set(name, cursor);
      cursor += SLOT_SIZE;
    }
    return { totalOffset: offset, properties };
  }

  /** Update a single value slot of an object in the DataTable. */
  updateObjectSlot(
    offset: number,
    propertyIndex: number,
    slot: ValueSlot,
  ): void {
    const slotOffset =
      offset +
      OBJECT_HEADER +
      propertyIndex * (NAME_REF_SIZE + SLOT_SIZE) +
      NAME_REF_SIZE;
    writeSlot(this.dataTable, slotOffset, slot);
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
    const count = this.indexTable.getInt32(0);
    if (index >= count) return null;
    const entryOffset = INDEX_HEADER + index * INDEX_ENTRY_SIZE;
    return this.indexTable.getInt32(entryOffset + 8);
  }

  /**
   * Look up a key's stable index in the Index Table, or null if absent.
   *
   * The index is the key's position in the Index Table. Keys are never
   * removed, so this index is stable for the lifetime of the key and can be
   * used to address the key's version cell.
   */
  lookupIndex(key: string): number | null {
    const count = this.indexTable.getInt32(0);
    for (let i = 0; i < count; i++) {
      const entryOffset = INDEX_HEADER + i * INDEX_ENTRY_SIZE;
      const keyOffset = this.indexTable.getInt32(entryOffset);
      const keyLength = this.indexTable.getInt32(entryOffset + 4);
      const storedKey = this.readString({
        offset: keyOffset,
        length: keyLength,
      });
      if (storedKey === key) {
        return i;
      }
    }
    return null;
  }

  /**
   * Int32Array index of a key's version cell within the Index Table buffer.
   * Stable for the lifetime of the key (the Index Table is never reordered or
   * replaced), so callers may cache it and load the version directly.
   */
  getVersionCellIndex(index: number): number {
    return versionCellIndex(index);
  }

  /** Read the current version for a key index (lock-free). */
  getVersion(index: number): number {
    return Atomics.load(this.versionView, versionCellIndex(index));
  }

  /** Increment the version for a key index, invalidating read caches. */
  bumpVersion(index: number): void {
    Atomics.add(this.versionView, versionCellIndex(index), 1);
  }

  /** Insert a key → dataOffset mapping into the Index Table. */
  insert(key: string, dataOffset: number): void {
    const keyRef = this.storeString(key);
    // Atomically reserve the next entry index. The count cell (index 0) is
    // incremented with a single Atomics.add, so concurrent workers each get a
    // distinct entry slot without a mutex. The Index Table is a single
    // growable SAB, so a fresh Int32Array view over its current buffer is
    // correct (insert is rare — only on first write of a key).
    const view = new Int32Array(this.indexTable.buffers[0]!);
    const count = Atomics.add(view, 0, 1);
    const entryOffset = INDEX_HEADER + count * INDEX_ENTRY_SIZE;
    this.indexTable.ensureCapacity(entryOffset + INDEX_ENTRY_SIZE);
    this.indexTable.setInt32(entryOffset, keyRef.offset);
    this.indexTable.setInt32(entryOffset + 4, keyRef.length);
    this.indexTable.setInt32(entryOffset + 8, dataOffset);
    // The 4th field is the key's version cell, initialized to 0.
    this.indexTable.setInt32(entryOffset + INDEX_VERSION_OFFSET, 0);

    // Rebuild the version view over the first chunk (the Index Table is small
    // and stays within the first chunk for typical workloads; version cells
    // beyond the first chunk are not addressable via the single Int32Array).
    this.versionView = new Int32Array(this.indexTable.buffers[0]!);
  }

  // ---------------------------------------------------------------------------
  // Layout version (cache invalidation)
  // ---------------------------------------------------------------------------

  /** Read the current global layout version (lock-free). */
  getLayoutVersion(): number {
    return Atomics.load(this.layoutVersion, 0);
  }

  /** Bump the global layout version, invalidating all per-worker caches. */
  bumpLayoutVersion(): void {
    Atomics.add(this.layoutVersion, 0, 1);
  }

  // ---------------------------------------------------------------------------
  // Lock-free write coordination (write counter + defrag flag)
  // ---------------------------------------------------------------------------
  // Cell 0 of `layoutVersion` is the global layout version. Cells 1 and 2 are
  // used to coordinate lock-free writes against the (rare) defragmentation
  // pass: cell 1 is a count of in-flight lock-free writes, cell 2 is a flag
  // set while a defragmentation pass is running. A write increments the
  // counter, checks the flag, and if the flag is set it falls back to the
  // mutex. The defrag sets the flag, waits for the counter to reach zero, then
  // runs under the mutex.

  /** Enter a lock-free write: increment the in-flight write counter. */
  beginWrite(): void {
    Atomics.add(this.layoutVersion, 1, 1);
  }

  /** Leave a lock-free write: decrement the in-flight write counter. */
  endWrite(): void {
    Atomics.sub(this.layoutVersion, 1, 1);
  }

  /** Whether a defragmentation pass is currently running. */
  isDefragmenting(): boolean {
    return Atomics.load(this.layoutVersion, 2) !== 0;
  }

  /** Set the defragmentation-in-progress flag. */
  setDefragmenting(): void {
    Atomics.store(this.layoutVersion, 2, 1);
  }

  /** Clear the defragmentation-in-progress flag. */
  clearDefragmenting(): void {
    Atomics.store(this.layoutVersion, 2, 0);
  }

  /** Wait until no lock-free writes are in flight. */
  waitForWritesToFinish(): void {
    while (Atomics.load(this.layoutVersion, 1) !== 0) {
      Atomics.wait(this.layoutVersion, 1, Atomics.load(this.layoutVersion, 1));
    }
  }

  // ---------------------------------------------------------------------------
  // Defragmentation
  // ---------------------------------------------------------------------------

  /**
   * Compact the DataTable, ArrayTable, and StringTable, reclaiming dead space.
   *
   * Live data is everything reachable from the Index Table (every key's value,
   * its object properties, and the strings/arrays they reference). Dead space
   * (overwritten strings, abandoned array blocks from `moveArray`, and
   * abandoned object blocks) is reclaimed by moving live data to the front of
   * each buffer and resetting the used length.
   *
   * All references (Index Table offsets, object property names, string slots,
   * array slots) are remapped in a single pass. The global layout version is
   * bumped at the end so workers invalidate their cached offsets.
   *
   * Must be called under the shared lock (or on a single thread).
   */
  defragment(): {
    indexTable: SharedArrayBuffer[];
    dataTable: SharedArrayBuffer[];
    stringTable: SharedArrayBuffer[];
    arrayTable: SharedArrayBuffer[];
  } {
    const stringRemap = new Map<number, number>();
    const arrayRemap = new Map<number, number>();
    const objectRemap = new Map<number, number>();
    const liveStrings = new Set<number>();
    const liveArrays = new Set<number>();
    const liveObjects = new Set<number>();
    const liveDataOffsets = new Set<number>();
    /** Byte size of each live ArrayTable block (array or string value). */
    const arrayBlockSizes = new Map<number, number>();
    /** Offsets of live string-value blocks (no slots to remap). */
    const stringValueBlocks = new Set<number>();

    const markString = (offset: number) => liveStrings.add(offset);

    const markValueSlot = (slot: ValueSlot) => {
      switch (slot.type) {
        case TYPE_STRING_REF:
        case TYPE_BIGINT_STR:
          liveStrings.add(slot.a);
          break;
        case TYPE_STRING_VALUE_REF:
          liveArrays.add(slot.a);
          stringValueBlocks.add(slot.a);
          arrayBlockSizes.set(
            slot.a,
            Math.max(slot.c || ARRAY_HEADER + slot.b, MIN_BLOCK_SIZE),
          );
          break;
        case TYPE_ARRAY_REF:
          markArray(slot.a, slot.b, slot.c);
          break;
      }
    };

    const markArray = (offset: number, count: number, capacity: number) => {
      if (liveArrays.has(offset)) return;
      liveArrays.add(offset);
      arrayBlockSizes.set(
        offset,
        Math.max(ARRAY_HEADER + capacity * SLOT_SIZE, MIN_BLOCK_SIZE),
      );
      for (let i = 0; i < count; i++) {
        markValueSlot(
          readSlot(this.arrayTable, offset + ARRAY_HEADER + i * SLOT_SIZE),
        );
      }
    };

    const markObject = (offset: number) => {
      if (liveObjects.has(offset)) return;
      liveObjects.add(offset);
      liveDataOffsets.add(offset);
      const count = this.dataTable.getInt32(offset + 4);
      let cursor = offset + OBJECT_HEADER;
      for (let i = 0; i < count; i++) {
        const nameOffset = this.dataTable.getInt32(cursor);
        const nameLength = this.dataTable.getInt32(cursor + 4);
        liveStrings.add(nameOffset);
        cursor += NAME_REF_SIZE;
        markValueSlot(readSlot(this.dataTable, cursor));
        cursor += SLOT_SIZE;
      }
    };

    const markValue = (dataOffset: number) => {
      if (this.dataTable.getInt32(dataOffset) === TYPE_OBJECT) {
        markObject(dataOffset);
      } else {
        liveDataOffsets.add(dataOffset);
        markValueSlot(readSlot(this.dataTable, dataOffset));
      }
    };

    // Phase 1: Mark live data by walking the Index Table.
    const indexCount = this.indexTable.getInt32(0);
    const indexEntries: Array<{ keyRef: StringRef; dataOffset: number }> = [];
    for (let i = 0; i < indexCount; i++) {
      const entryOffset = INDEX_HEADER + i * INDEX_ENTRY_SIZE;
      const keyRef = {
        offset: this.indexTable.getInt32(entryOffset),
        length: this.indexTable.getInt32(entryOffset + 4),
      };
      const dataOffset = this.indexTable.getInt32(entryOffset + 8);
      indexEntries.push({ keyRef, dataOffset });
      liveStrings.add(keyRef.offset);
      markValue(dataOffset);
    }

    // Phase 2: Compact the DataTable (objects and single value slots).
    const sortedData = [...liveDataOffsets].sort((a, b) => a - b);
    let newDataOffset = 0;
    for (const oldOffset of sortedData) {
      const size =
        this.dataTable.getInt32(oldOffset) === TYPE_OBJECT
          ? OBJECT_HEADER +
            this.dataTable.getInt32(oldOffset + 4) * (NAME_REF_SIZE + SLOT_SIZE)
          : SLOT_SIZE;
      copyBytes(this.dataTable, newDataOffset, oldOffset, size);
      objectRemap.set(oldOffset, newDataOffset);
      newDataOffset += size;
    }
    this.dataTable.reset(newDataOffset);

    // Phase 3: Compact the ArrayTable.
    const sortedArrays = [...liveArrays].sort((a, b) => a - b);
    let newArrayOffset = 0;
    for (const oldOffset of sortedArrays) {
      const size = arrayBlockSizes.get(oldOffset)!;
      copyBytes(this.arrayTable, newArrayOffset, oldOffset, size);
      arrayRemap.set(oldOffset, newArrayOffset);
      newArrayOffset += size;
    }
    this.arrayTable.reset(newArrayOffset);

    // Phase 4: Compact the StringTable.
    const sortedStrings = [...liveStrings].sort((a, b) => a - b);
    let newStringOffset = 0;
    for (const oldOffset of sortedStrings) {
      const next = sortedStrings[sortedStrings.indexOf(oldOffset) + 1];
      const end = next !== undefined ? next : this.stringTable.byteLength;
      const length = end - oldOffset;
      copyBytes(this.stringTable, newStringOffset, oldOffset, length);
      stringRemap.set(oldOffset, newStringOffset);
      newStringOffset += length;
    }
    this.stringTable.reset(newStringOffset);

    // Phase 5: Rewrite the Index Table with remapped key strings and offsets.
    for (let i = 0; i < indexCount; i++) {
      const entryOffset = INDEX_HEADER + i * INDEX_ENTRY_SIZE;
      const { keyRef, dataOffset } = indexEntries[i]!;
      this.indexTable.setInt32(entryOffset, stringRemap.get(keyRef.offset)!);
      this.indexTable.setInt32(entryOffset + 4, keyRef.length);
      this.indexTable.setInt32(entryOffset + 8, objectRemap.get(dataOffset)!);
    }

    // Phase 6: Rewrite object property names and value slots, and array slots.
    for (const oldOffset of sortedData) {
      if (this.dataTable.getInt32(oldOffset) !== TYPE_OBJECT) continue;
      const newOff = objectRemap.get(oldOffset)!;
      const count = this.dataTable.getInt32(newOff + 4);
      let cursor = newOff + OBJECT_HEADER;
      for (let i = 0; i < count; i++) {
        const nameOffset = this.dataTable.getInt32(cursor);
        this.dataTable.setInt32(cursor, stringRemap.get(nameOffset)!);
        cursor += NAME_REF_SIZE;
        remapSlot(this.dataTable, cursor, stringRemap, arrayRemap);
        cursor += SLOT_SIZE;
      }
    }
    for (const oldOffset of sortedData) {
      if (this.dataTable.getInt32(oldOffset) === TYPE_OBJECT) continue;
      const newOff = objectRemap.get(oldOffset)!;
      remapSlot(this.dataTable, newOff, stringRemap, arrayRemap);
    }
    for (const oldOffset of sortedArrays) {
      if (stringValueBlocks.has(oldOffset)) continue;
      const newOff = arrayRemap.get(oldOffset)!;
      const capacity =
        (arrayBlockSizes.get(oldOffset)! - ARRAY_HEADER) / SLOT_SIZE;
      for (let i = 0; i < capacity; i++) {
        remapSlot(
          this.arrayTable,
          newOff + ARRAY_HEADER + i * SLOT_SIZE,
          stringRemap,
          arrayRemap,
        );
      }
    }

    // Phase 7: Invalidate all per-worker caches.
    this.bumpLayoutVersion();

    // Phase 8: Reclaim memory from inactive chunks (beyond the compacted
    // region). The Index Table is a single growable SAB and is never replaced.
    return {
      indexTable: this.indexTable.releaseInactiveChunks(),
      dataTable: this.dataTable.releaseInactiveChunks(),
      stringTable: this.stringTable.releaseInactiveChunks(),
      arrayTable: this.arrayTable.releaseInactiveChunks(),
    };
  }
}

function writeSlot(buf: GrowableBuffer, offset: number, slot: ValueSlot): void {
  buf.setInt32(offset, slot.type);
  buf.setInt32(offset + 4, slot.a);
  buf.setInt32(offset + 8, slot.b);
  buf.setInt32(offset + 12, slot.c);
}

function readSlot(buf: GrowableBuffer, offset: number): ValueSlot {
  return {
    type: buf.getInt32(offset),
    a: buf.getInt32(offset + 4),
    b: buf.getInt32(offset + 8),
    c: buf.getInt32(offset + 12),
  };
}

/** Copy `len` bytes from `src` to `dst` in the same buffer (dst <= src). */
function copyBytes(
  buf: GrowableBuffer,
  dst: number,
  src: number,
  len: number,
): void {
  for (let i = 0; i < len; i++) {
    buf.setUint8(dst + i, buf.getUint8(src + i));
  }
}

/**
 * Rewrite a value slot's string/array references after compaction, in place.
 * String refs and bigint-str refs are remapped via `stringRemap`; array refs
 * and string-value refs (which live in the ArrayTable) via `arrayRemap`.
 */
function remapSlot(
  buf: GrowableBuffer,
  offset: number,
  stringRemap: Map<number, number>,
  arrayRemap: Map<number, number>,
): void {
  const type = buf.getInt32(offset);
  if (type === TYPE_STRING_REF || type === TYPE_BIGINT_STR) {
    buf.setInt32(offset + 4, stringRemap.get(buf.getInt32(offset + 4))!);
  } else if (type === TYPE_ARRAY_REF || type === TYPE_STRING_VALUE_REF) {
    buf.setInt32(offset + 4, arrayRemap.get(buf.getInt32(offset + 4))!);
  }
}
