/**
 * Serialization helpers for encoding/decoding values into a byte buffer
 * that can be stored in shared memory.
 *
 * Format (little-endian):
 *   - null        -> 0x00
 *   - boolean     -> 0x01 + 1 byte
 *   - number      -> 0x02 + 8 bytes (float64)
 *   - bigint      -> 0x03 + 8 bytes (int64)
 *   - string      -> 0x04 + 4 bytes length + utf8 bytes
 *   - array       -> 0x05 + 4 bytes count + elements
 *   - object      -> 0x06 + 4 bytes count + (key, value) pairs
 *   - undefined   -> 0x07
 */

const TYPE_NULL = 0x00;
const TYPE_BOOLEAN = 0x01;
const TYPE_NUMBER = 0x02;
const TYPE_BIGINT = 0x03;
const TYPE_STRING = 0x04;
const TYPE_ARRAY = 0x05;
const TYPE_OBJECT = 0x06;
const TYPE_UNDEFINED = 0x07;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Compute the number of bytes needed to serialize a value. */
export function encodedSize(value: unknown): number {
  switch (typeof value) {
    case "boolean":
      return 2;
    case "number":
      return 9;
    case "bigint":
      return 9;
    case "string":
      return 5 + encoder.encode(value).byteLength;
    case "undefined":
      return 1;
    case "object": {
      if (value === null) return 1;
      if (Array.isArray(value)) {
        let size = 5;
        for (const item of value) size += encodedSize(item);
        return size;
      }
      let size = 5;
      for (const [k, v] of Object.entries(value)) {
        size += 4 + encoder.encode(k).byteLength + encodedSize(v);
      }
      return size;
    }
    default:
      throw new TypeError(`Cannot serialize value of type ${typeof value}`);
  }
}

/** Serialize a value into a Uint8Array. */
export function serialize(value: unknown): Uint8Array {
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
      case "undefined": {
        out[offset++] = TYPE_UNDEFINED;
        break;
      }
      case "object": {
        if (v === null) {
          out[offset++] = TYPE_NULL;
          break;
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
      case TYPE_NULL:
        return null;
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
      case TYPE_UNDEFINED:
        return undefined;
      default:
        throw new Error(`Unknown type tag ${type} at offset ${offset - 1}`);
    }
  };

  return read();
}
