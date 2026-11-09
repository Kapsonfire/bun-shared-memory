import { describe, expect, test } from "bun:test";
import { Shared, SharedMemory, getDefaultMemory } from "../src/index.ts";

describe("one SharedMemory per thread", () => {
  test("a second instance in the same thread is rejected", () => {
    const mem = new SharedMemory();
    expect(SharedMemory.current()).toBe(mem);
    expect(() => new SharedMemory()).toThrow(/already exists/);
    expect(() => SharedMemory.fromBuffers(mem.exportBuffers())).toThrow(
      /already exists/,
    );
    // The default memory is that same single instance.
    expect(getDefaultMemory()).toBe(mem);
  });

  test("dispose() frees the slot and resets the per-thread caches", () => {
    const first = new SharedMemory();
    const a = Shared("single-key", { n: 1 }, { memory: first });
    expect(a.n).toBe(1);
    first.dispose();
    expect(SharedMemory.current()).toBeNull();

    // Same key in a fresh memory must not see the first memory's caches.
    const second = new SharedMemory();
    const b = Shared("single-key", { n: 42 }, { memory: second });
    expect(b.n).toBe(42);
  });

  test("a worker cannot create a fresh memory; only the main thread can", async () => {
    const code = `
      import { SharedMemory } from ${JSON.stringify(
        new URL("../src/index.ts", import.meta.url).href,
      )};
      self.onmessage = (e) => {
        let message = "no error";
        try { new SharedMemory(); } catch (err) { message = String(err.message); }
        // Reconstructing from the main thread's buffers is the allowed way.
        const mem = new SharedMemory({ buffers: e.data });
        self.postMessage({ message, reconstructed: SharedMemory.current() === mem });
      };
    `;
    const mem = new SharedMemory();
    const worker = new Worker(
      new URL(
        "data:text/javascript," + encodeURIComponent(code),
        import.meta.url,
      ),
      { type: "module" },
    );
    const reply = await new Promise<{
      message: string;
      reconstructed: boolean;
    }>((resolve, reject) => {
      worker.onerror = (e) => reject(e);
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(mem.exportBuffers());
    });
    worker.terminate();
    expect(reply.message).toMatch(/main thread/);
    expect(reply.reconstructed).toBe(true);
  });
});
