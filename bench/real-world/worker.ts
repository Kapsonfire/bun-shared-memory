/**
 * Benchmark worker.
 *
 * Each worker builds its own Elysia instance for the assigned methodology and
 * processes its share of the requests. Requests are built by hand and passed
 * directly to `app.fetch()` — no HTTP server, no network I/O.
 *
 * For the "shared" methodology the worker calls `await init()` first so it
 * receives the shared buffers from the main thread.
 */
import { init } from "../../src/index.ts";
import { buildApi, type Methodology } from "./api.ts";

const workerScope = globalThis as unknown as {
  postMessage: (m: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

interface BenchRequest {
  type: "bench";
  methodology: Methodology;
  /** Number of requests this worker should process. */
  count: number;
  /** The user id to read (rotated across requests). */
  userId: number;
}

interface ResultMessage {
  type: "result";
  methodology: Methodology;
  /** Total wall-clock time in ms to process all requests. */
  elapsedMs: number;
  /** Number of requests processed. */
  count: number;
}

workerScope.onmessage = async (e: MessageEvent) => {
  const msg = e.data as BenchRequest;
  if (msg.type !== "bench") return;

  const { methodology, count, userId } = msg;

  // Shared-memory workers must receive the buffers from the main thread.
  if (methodology === "shared") {
    await init();
  }

  const app = buildApi({ methodology });

  // Warm up the handler (JIT) before measuring.
  for (let i = 0; i < 1000; i++) {
    await app.fetch(new Request(`http://localhost/user/${userId}`));
  }

  const start = performance.now();
  for (let i = 0; i < count; i++) {
    // Rotate the id so reads hit different rows (like real traffic).
    const id = userId + (i % 10);
    await app.fetch(new Request(`http://localhost/user/${id}`));
  }
  const elapsedMs = performance.now() - start;

  const result: ResultMessage = { type: "result", methodology, elapsedMs, count };
  workerScope.postMessage(result);
};
