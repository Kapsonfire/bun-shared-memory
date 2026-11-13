import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory } from "../src/index.ts";

/**
 * A read that follows a write misses the whole-value cache. The first such
 * miss per version reads only the requested element's slot; these tests pin
 * the semantics of that fast path against the general (full decode) path.
 */
describe("array element reads after a write", () => {
  const LONG = "a string that is longer than eleven bytes";

  test("top-level array: every element type round-trips after a write", () => {
    const mem = new SharedMemory();
    const arr = Shared<unknown[]>("er-top", [0, 0, 0, 0, 0, 0], {
      memory: mem,
    });
    arr.read(); // fill the whole-value cache

    const values: unknown[] = [
      1.5,
      "short",
      LONG,
      12345678901234567890n,
      true,
      null,
    ];
    values.forEach((v, i) => {
      arr[i] = v;
      // First read after the write: element fast path.
      expect(arr[i]).toEqual(v);
      // Neighbours stay intact.
      if (i + 1 < values.length) expect(arr[i + 1]).toBe(0);
    });
    // Same version, repeated reads: whole decode fills the cache, still right.
    values.forEach((v, i) => expect(arr[i]).toEqual(v));
    expect(arr.read()).toEqual(values);
  });

  test("out-of-bounds, length changes, push and pop", () => {
    const mem = new SharedMemory();
    const arr = Shared<number[]>("er-bounds", [1, 2, 3], { memory: mem });
    arr.read();
    arr[0] = 10;
    expect(arr[3]).toBeUndefined(); // out of bounds right after a write
    arr.push(4);
    expect(arr[3]).toBe(4);
    arr[1] = 20;
    expect(arr.length).toBe(4);
    arr.pop();
    arr[0] = 11;
    expect(arr[3]).toBeUndefined();
    expect(arr[2]).toBe(3);
    expect(arr.read()).toEqual([11, 20, 3]);
  });

  test("elements that are arrays or objects use the general path", () => {
    const mem = new SharedMemory();
    const arr = Shared<unknown[]>("er-nested", [[1, 2], { a: 1 }, 5], {
      memory: mem,
    });
    arr.read();
    arr[2] = 6; // a write: the next reads miss the cache
    expect((arr[0] as number[])[1]).toBe(2);
    expect((arr[1] as { a: number }).a).toBe(1);
    expect(arr[2]).toBe(6);
  });

  test("non-index keys are untouched by the element path", () => {
    const mem = new SharedMemory();
    const arr = Shared<number[]>("er-keys", [1, 2], { memory: mem });
    arr.read();
    arr[0] = 5;
    expect(arr.length).toBe(2);
    expect(
      (arr as unknown as Record<string, unknown>)["12abc"],
    ).toBeUndefined();
    expect((arr as unknown as Record<string, unknown>)["1.5"]).toBeUndefined();
  });

  test("array property of an object: reads right after each write", () => {
    const mem = new SharedMemory();
    const o = Shared(
      "er-prop",
      { list: [0, 0, 0] as unknown[], n: 0 },
      { memory: mem },
    );
    o.list; // fill caches
    for (let i = 0; i < 20; i++) {
      o.list[i % 3] = i;
      expect(o.list[i % 3]).toBe(i);
      o.n = i; // a write to another property also bumps the version
      expect(o.list[i % 3]).toBe(i);
    }
    o.list[0] = LONG;
    expect(o.list[0]).toBe(LONG);
    expect(o.list[3]).toBeUndefined();
  });

  test("a write from another thread is visible to the element path", async () => {
    const mem = new SharedMemory();
    const arr = Shared<number[]>("er-worker", [0, 0, 0, 0], { memory: mem });
    arr.read();
    const buffers = mem.exportBuffers();
    const code = `
      import { SharedMemory, Shared } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        const mem = SharedMemory.fromBuffers(e.data);
        const a = Shared("er-worker", [], { memory: mem });
        a[2] = 42;
        self.postMessage("done");
      };
    `;
    const worker = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(code),
        import.meta.url,
      ),
      { type: "module" },
    );
    await new Promise<void>((resolve, reject) => {
      worker.onerror = (e) => reject(e);
      worker.onmessage = () => resolve();
      worker.postMessage(buffers);
    });
    worker.terminate();
    expect(arr[2]).toBe(42);
    expect(arr[1]).toBe(0);
  });
});

/**
 * An array proxy remembers the read-cache entry of its last index read and
 * answers further index reads from it while the key's version is unchanged.
 * Every kind of write must make it read the new value.
 */
describe("array proxy index-read cache", () => {
  test("array property: element writes, whole writes, push/pop, sibling writes", () => {
    const mem = new SharedMemory();
    const o = Shared<{ n: number; tags: unknown[] }>(
      "apc-prop",
      { n: 0, tags: [1, 2, 3] },
      { memory: mem },
    );
    const tags = o.tags;
    // Warm: two reads at the same version, the second from the proxy's entry.
    expect(tags[0]).toBe(1);
    expect(tags[0]).toBe(1);
    expect(tags[1]).toBe(2);

    tags[1] = "x";
    expect(tags[1]).toBe("x");
    expect(tags[1]).toBe("x");

    o.tags = [7, 8, 9, 10];
    expect(tags[3]).toBe(10);
    expect(tags[0]).toBe(7);
    expect(tags[0]).toBe(7);

    tags.push(11);
    expect(tags[4]).toBe(11);
    expect(tags[4]).toBe(11);
    tags.pop();
    expect(tags[4]).toBeUndefined();
    expect(tags[4]).toBeUndefined();

    // A write to another property bumps the same key's version.
    o.n = 5;
    expect(tags[0]).toBe(7);
    tags[0] = 70;
    o.n = 6;
    expect(tags[0]).toBe(70);
    expect(tags[0]).toBe(70);
  });

  test("nested array in an array, object elements and out of bounds", () => {
    const mem = new SharedMemory();
    const o = Shared<{ grid: unknown[][] }>(
      "apc-nested",
      {
        grid: [
          [1, { x: 1 }],
          [3, 4],
        ],
      },
      { memory: mem },
    );
    const row = o.grid[0]!;
    expect(row[0]).toBe(1);
    expect(row[0]).toBe(1);
    // Object elements still come back as live child proxies.
    expect((row[1] as { x: number }).x).toBe(1);
    expect((row[1] as { x: number }).x).toBe(1);
    expect(row[9]).toBeUndefined();

    row[0] = 2;
    expect(row[0]).toBe(2);
    expect(row[0]).toBe(2);
    (row[1] as { x: number }).x = 5;
    expect((row[1] as { x: number }).x).toBe(5);
    expect(o.read().grid).toEqual([
      [2, { x: 5 }],
      [3, 4],
    ]);
  });

  test("non-index names that start with a digit still reach the array", () => {
    const mem = new SharedMemory();
    const o = Shared<{ tags: number[] }>(
      "apc-names",
      { tags: [1, 2] },
      { memory: mem },
    );
    const tags = o.tags;
    expect(tags[0]).toBe(1);
    expect((tags as unknown as Record<string, unknown>)["1a"]).toBeUndefined();
    expect(tags.length).toBe(2);
    expect(tags.includes(2)).toBe(true);
    expect([...tags]).toEqual([1, 2]);
  });
});
