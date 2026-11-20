import { describe, expect, test } from "bun:test";
import { Shared } from "../src/index.ts";
import {
  SharedMemory,
  decodeDateSlot,
  decodeSlot,
  dateSlot,
} from "../src/memory.ts";

describe("date objects", () => {
  test("date property round-trips through the proxy", () => {
    const mem = new SharedMemory();
    const o = Shared("date-props", { when: new Date(0) }, { memory: mem });

    const ts = 1700000000000;
    o.when = new Date(ts);
    expect(o.when).toBeInstanceOf(Date);
    expect(o.when.getTime()).toBe(ts);

    const read = o.read();
    expect(read.when.getTime()).toBe(ts);
  });

  test("invalid date (NaN) round-trips", () => {
    const mem = new SharedMemory();
    const o = Shared("date-invalid", { d: new Date(NaN) }, { memory: mem });
    expect(o.d).toBeInstanceOf(Date);
    expect(Number.isNaN(o.d.getTime())).toBe(true);
  });

  test("pre-epoch (negative) timestamps round-trip", () => {
    const mem = new SharedMemory();
    const o = Shared("date-negative", { d: new Date(-86400000) }, { memory: mem });
    expect(o.d.getTime()).toBe(-86400000);
  });

  test("millisecond precision is preserved", () => {
    const mem = new SharedMemory();
    const o = Shared("date-ms", { d: new Date(1234567890123) }, { memory: mem });
    expect(o.d.getTime()).toBe(1234567890123);
  });

  test("date nested inside an array round-trips", () => {
    const mem = new SharedMemory();
    const o = Shared(
      "date-array",
      { list: [new Date(0), new Date(1000000000000)] },
      { memory: mem },
    );
    expect(o.list[0]).toBeInstanceOf(Date);
    expect((o.list[0] as Date).getTime()).toBe(0);
    expect((o.list[1] as Date).getTime()).toBe(1000000000000);
    const readList = o.read().list as unknown[];
    expect((readList[1] as Date).getTime()).toBe(1000000000000);
  });

  test("date nested inside an object round-trips", () => {
    const mem = new SharedMemory();
    const o = Shared(
      "date-nested",
      { meta: { created: new Date(987654321000) } },
      { memory: mem },
    );
    expect(o.meta.created).toBeInstanceOf(Date);
    expect(o.meta.created.getTime()).toBe(987654321000);
    expect(o.read().meta.created.getTime()).toBe(987654321000);
  });

  test("dates survive a full read() deep copy", () => {
    const mem = new SharedMemory();
    const o = Shared("date-copy", { nested: { d: new Date(555000) } }, { memory: mem });
    const read = o.read();
    expect(read.nested.d).toBeInstanceOf(Date);
    expect(read.nested.d.getTime()).toBe(555000);
    // Mutating the copy must not affect the shared value.
    read.nested.d = new Date(999000);
    expect(o.nested.d.getTime()).toBe(555000);
  });

  test("date slot packs a float64 timestamp and decodes", () => {
    const ts = 1700000000000;
    const slot = dateSlot(ts);
    expect(slot.type).toBe(12); // TYPE_DATE
    expect(decodeDateSlot(slot).getTime()).toBe(ts);
    expect(decodeSlot(slot)).toBeInstanceOf(Date);
    expect((decodeSlot(slot) as Date).getTime()).toBe(ts);
  });

  test("map/set are still rejected", () => {
    expect(() => {
      const mem = new SharedMemory();
      Shared("date-reject-map", { m: new Map([["a", 1]]) }, { memory: mem });
    }).toThrow();
    expect(() => {
      const mem = new SharedMemory();
      Shared("date-reject-set", { s: new Set([1]) }, { memory: mem });
    }).toThrow();
  });
});
