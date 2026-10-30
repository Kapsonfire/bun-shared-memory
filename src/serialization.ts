/**
 * Serialization helpers for encoding/decoding values into a byte buffer
 * that can be stored in shared memory.
 *
 * Allowed value types:
 *   - primitives: number, string, boolean
 *   - bigint
 *   - arrays of the above (mixed arrays allowed)
 *   - objects with a fixed shape (values are primitives, bigints, or arrays)
 *
 * Not allowed: null, undefined, nested objects, nested arrays.
 *
 * Format (little-endian):
 *   - boolean     -> 0x01 + 1 byte
 *   - number      -> 0x02 + 8 bytes (float64)
 *   - bigint      -> 0x03 + 8 bytes (int64)
 *   - string      -> 0x04 + 4 bytes length + utf8 bytes
 *   - array       -> 0x05 + 4 bytes count + elements
 *   - object      -> 0x06 + 4 bytes count + (key, value) pairs
 */

const TYPE_BOOLEAN = 0x01;
const TYPE_NUMBER = 0x02;
const TYPE_BIGINT = 0x03;
const TYPE_STRING = 0x04;
const TYPE_ARRAY = 0x05;
const TYPE_OBJECT = 0x06;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A primitive value that can be stored in shared memory. */
export type Primitive = number | string | boolean | bigint;

/** A value that can be stored in shared memory. */
export type SharedValue =
  | Primitive
  | Primitive[]
  | { [key: string]: Primitive | Primitive[] };

function isPrimitive(v: unknown): v is Primitive {
  return (
    typeof v === "number" ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    typeof v === "bigint"
  );
}

function assertValid(value: unknown, path: string): void {
  if (isPrimitive(value)) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!isPrimitive(value[i])) {
        throw new TypeError(
          `Invalid value at ${path}[${i}]: arrays may only contain primitives and bigints (got ${typeof value[i]})`,
        );
      }
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (isPrimitive(v)) continue;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (!isPrimitive(v[i])) {
            throw new TypeError(
              `Invalid value at ${path}.${k}[${i}]: arrays may only contain primitives and bigints (got ${typeof v[i]})`,
            );
          }
        }
        continue;
      }
      throw new TypeError(
        `Invalid value at ${path}.${k}: only primitives, bigints, and arrays of these are allowed (got ${typeof v})`,
      );
    }
    return;
  }
  throw new TypeError(
    `Invalid value at ${path}: only primitives, bigints, and arrays of these are allowed (got ${typeof value})`,
  );
}

/** Compute the number of bytes needed to serialize a value. */
export function encodedSize(value: unknown): number {
  if (isPrimitive(value)) {
    switch (typeof value) {
      case "boolean":
        return 2;
      case "number":
        return 9;
      case "bigint":
        return 9;
      case "string":
        return 5 + encoder.encode(value).byteLength;
    }
  }
  if (Array.isArray(value)) {
    let size = 5;
    for (const item of value) size += encodedSize(item);
    return size;
  }
  if (value !== null && typeof value === "object") {
    let size = 5;
    for (const [k, v] of Object.entries(value)) {
      size += 4 + encoder.encode(k).byteLength + encodedSize(v);
    }
    return size;
  }
  throw new TypeError(`Cannot serialize value of type ${typeof value}`);
}

/** Serialize a value into a Uint8Array. */
export function serialize(value: unknown): Uint8Array {
  assertValid(value, "$");
  const size = encodedSize(value);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;

  const write = (v: unknown): void => {
    switch (typeof v) {
      case "boolean": {
        out[offset++] = TYPE_BOOLEAN;
        out[offset++] = v ? 1 : 0;
        break;
      }
      case "number": {
        out[offset++] = TYPE_NUMBER;
        view.setFloat64(offset, v, true);
        offset += 8;
        break;
      }
      case "bigint": {
        out[offset++] = TYPE_BIGINT;
        view.setBigInt64(offset, v, true);
        offset += 8;
        break;
      }
      case "string": {
        out[offset++] = TYPE_STRING;
        const bytes = encoder.encode(v);
        view.setUint32(offset, bytes.byteLength, true);
        offset += 4;
        out.set(bytes, offset);
        offset += bytes.byteLength;
        break;
      }
      case "object": {
        if (v === null) {
          throw new TypeError("Cannot serialize null");
        }
        if (Array.isArray(v)) {
          out[offset++] = TYPE_ARRAY;
          view.setUint32(offset, v.length, true);
          offset += 4;
          for (const item of v) write(item);
          break;
        }
        out[offset++] = TYPE_OBJECT;
        const entries = Object.entries(v);
        view.setUint32(offset, entries.length, true);
        offset += 4;
        for (const [k, val] of entries) {
          const keyBytes = encoder.encode(k);
          view.setUint32(offset, keyBytes.byteLength, true);
          offset += 4;
          out.set(keyBytes, offset);
          offset += keyBytes.byteLength;
          write(val);
        }
        break;
      }
      default:
        throw new TypeError(`Cannot serialize value of type ${typeof v}`);
    }
  };

  write(value);
  return out;
}

/** Deserialize a value from a Uint8Array. */
export function deserialize(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const read = (): unknown => {
    const type = bytes[offset++];
    switch (type) {
      case TYPE_BOOLEAN:
        return bytes[offset++] === 1;
      case TYPE_NUMBER: {
        const v = view.getFloat64(offset, true);
        offset += 8;
        return v;
      }
      case TYPE_BIGINT: {
        const v = view.getBigInt64(offset, true);
        offset += 8;
        return v;
      }
      case TYPE_STRING: {
        const len = view.getUint32(offset, true);
        offset += 4;
        const s = decoder.decode(bytes.subarray(offset, offset + len));
        offset += len;
        return s;
      }
      case TYPE_ARRAY: {
        const count = view.getUint32(offset, true);
        offset += 4;
        const arr: unknown[] = [];
        for (let i = 0; i < count; i++) arr.push(read());
        return arr;
      }
      case TYPE_OBJECT: {
        const count = view.getUint32(offset, true);
        offset += 4;
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const keyLen = view.getUint32(offset, true);
          offset += 4;
          const key = decoder.decode(bytes.subarray(offset, offset + keyLen));
          offset += keyLen;
          obj[key] = read();
        }
        return obj;
      }
      default:
        throw new Error(`Unknown type tag ${type} at offset ${offset - 1}`);
    }
  };

  return read();
}
