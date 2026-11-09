import { describe, expect, test } from "bun:test";
import { Shared } from "../src/index.ts";
import { SharedMemory, decodeSlot } from "../src/memory.ts";

/**
 * Defragmentation packs blocks back to back, so a 16-byte value slot can
 * straddle a chunk boundary. The slot fast paths resolve the chunk once; they
 * must fall back to per-field access for such slots.
 */
describe("value slots that straddle a chunk boundary", () => {
  const CHUNK = 4 * 1024 * 1024;
  // The slot starts 8 bytes before the boundary: type/a in chunk 0, b/c in 1.
  const OFFSET = CHUNK - 8;

  function memory(): SharedMemory {
    const mem = new SharedMemory({ chunkSize: CHUNK });
    // Make sure both chunks are active.
    mem.dataTable.ensureCapacity(CHUNK + 64);
    mem.arrayTable.ensureCapacity(CHUNK + 64);
    return mem;
  }

  test("data table number, boolean and bigint slots round-trip", () => {
    const mem = memory();
    mem.updateNumberSlot(OFFSET, 1234.5678);
    expect(decodeSlot(mem.readValueSlot(OFFSET))).toBe(1234.5678);
    mem.updateBooleanSlot(OFFSET, true);
    expect(decodeSlot(mem.readValueSlot(OFFSET))).toBe(true);
    mem.updateBigIntSlot(OFFSET, -9007199254740993n);
    expect(decodeSlot(mem.readValueSlot(OFFSET))).toBe(-9007199254740993n);
    // The generic path agrees with the fast paths.
    mem.updateValueSlot(OFFSET, { type: 0, a: 0, b: 0, c: 0 });
    expect(mem.readValueSlot(OFFSET)).toEqual({ type: 0, a: 0, b: 0, c: 0 });
  });

  test("array number, boolean and bigint slots round-trip", () => {
    const mem = memory();
    // Array block header is 4 bytes, so index 0 sits at ref.offset + 4.
    const ref = { offset: OFFSET - 4, count: 1, capacity: 1 };
    mem.updateArrayNumberSlot(ref, 0, -0.125);
    expect(decodeSlot(mem.readArraySlot(ref, 0))).toBe(-0.125);
    mem.updateArrayBooleanSlot(ref, 0, false);
    expect(decodeSlot(mem.readArraySlot(ref, 0))).toBe(false);
    mem.updateArrayBigIntSlot(ref, 0, 42n);
    expect(decodeSlot(mem.readArraySlot(ref, 0))).toBe(42n);
  });

  test("slots inside a chunk still use the fast path and agree with it", () => {
    const mem = memory();
    mem.updateNumberSlot(64, 7.25);
    expect(decodeSlot(mem.readValueSlot(64))).toBe(7.25);
    expect(mem.dataTable.getInt32(64)).toBe(0); // TYPE_NUMBER
  });
});

describe("inline strings (ASCII fast path and UTF-8 fallback)", () => {
  const samples = [
    "", // empty
    "a",
    "short",
    "exactly 11!", // 11 ASCII chars: the longest inline string
    "twelve chars", // 12 chars: goes to the heap
    "äöüß", // 2 bytes each: inline
    "äöüßä", // 10 bytes: inline
    "äöüßäö", // 12 bytes: heap
    "日本語", // 3 bytes each
    "日本語日", // 12 bytes: heap
    "😀😀", // 4-byte sequences
    "mixed é1", // ASCII and non-ASCII
    "\u0000\u007f\u0001", // NUL / DEL / control characters
  ];

  test("object property writes round-trip through every sample", () => {
    const mem = new SharedMemory();
    const o = Shared("inline-object", { s: "init" }, { memory: mem });
    for (const text of samples) {
      o.s = text;
      expect(o.s).toBe(text);
      expect(o.read().s).toBe(text);
    }
  });

  test("array element writes round-trip through every sample", () => {
    const mem = new SharedMemory();
    const list = Shared<string[]>("inline-array", ["x", "y"], { memory: mem });
    for (const text of samples) {
      list[0] = text;
      expect(list[0]).toBe(text);
      expect(list.read()[0]).toBe(text);
      expect(list[1]).toBe("y"); // the neighbouring slot stays intact
    }
  });
});
