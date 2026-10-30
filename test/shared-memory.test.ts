import { describe, expect, test } from "bun:test";
import { SharedMemory } from "../src/index.ts";

describe("SharedMemory", () => {
  test("creates a buffer of the requested size", () => {
    const sm = new SharedMemory(1024);
    expect(sm.byteLength).toBe(1024);
    expect(sm.buffer.byteLength).toBe(1024);
  });

  test("rejects invalid sizes", () => {
    expect(() => new SharedMemory(0)).toThrow(RangeError);
    expect(() => new SharedMemory(-1)).toThrow(RangeError);
    expect(() => new SharedMemory(1.5)).toThrow(RangeError);
  });

  test("provides a typed array view", () => {
    const sm = new SharedMemory(16);
    const view = sm.view(Uint8Array);
    view[0] = 42;
    expect(view[0]).toBe(42);
  });

  test("provides a sliced typed array view", () => {
    const sm = new SharedMemory(16);
    const view = sm.viewSlice(Uint8Array, 4, 4);
    expect(view.byteLength).toBe(4);
    view[0] = 7;
    expect(view[0]).toBe(7);
  });

  test("rejects out-of-bounds slice", () => {
    const sm = new SharedMemory(16);
    expect(() => sm.viewSlice(Uint8Array, 20)).toThrow(RangeError);
  });

  test("exposes the raw SharedArrayBuffer", () => {
    const sm = new SharedMemory(8);
    expect(sm.raw).toBeInstanceOf(SharedArrayBuffer);
  });
});
