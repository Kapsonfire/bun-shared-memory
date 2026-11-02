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
import { buildApi, type Methodology, type Transport } from "./api.ts";

const workerScope = globalThis as unknown as {
  postMessage: (m: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

interface BenchRequest {
  type: "bench";
  methodology: Methodology;
  /** Transport for MySQL/Redis ("tcp" or "socket"). */
  transport?: Transport;
  /** Number of requests this worker should process per sample. */
  count: number;
  /** The user id to read (rotated across requests). */
  userId: number;
  /** Number of measured samples; the worker reports the minimum. */
  samples: number;
}

interface ResultMessage {
  type: "result";
  methodology: Methodology;
  /** Best (minimum) wall-clock time in ms across all samples. */
  elapsedMs: number;
  /** Number of requests processed per sample. */
  count: number;
}

interface ErrorMessage {
  type: "error";
  methodology: Methodology;
  message: string;
}

workerScope.onmessage = async (e: MessageEvent) => {
  const msg = e.data as BenchRequest;
  if (msg.type !== "bench") return;

  const { methodology, count, userId, transport, samples } = msg;

  try {
    // Shared-memory workers must receive the buffers from the main thread.
    if (methodology === "shared") {
      await init();
    }

    const app = await buildApi({ methodology, transport });

    // Warm up the handler (JIT) before measuring.
    for (let i = 0; i < 1000; i++) {
      await app.fetch(new Request(`http://localhost/user/${userId}`));
    }

    // Run several samples and keep the minimum. CPU contention (other
    // processes, the IDE, etc.) can only slow a sample down, never speed it
    // up, so the minimum is the best estimate of the true throughput.
    let best = Infinity;
    for (let s = 0; s < samples; s++) {
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        // Rotate the id so reads hit different rows (like real traffic).
        const id = userId + (i % 10);
        await app.fetch(new Request(`http://localhost/user/${id}`));
      }
      const elapsedMs = performance.now() - start;
      if (elapsedMs < best) best = elapsedMs;
    }

    const result: ResultMessage = {
      type: "result",
      methodology,
      elapsedMs: best,
      count,
    };
    workerScope.postMessage(result);
  } catch (err) {
    const errorMsg: ErrorMessage = {
      type: "error",
      methodology,
      message: err instanceof Error ? err.message : String(err),
    };
    workerScope.postMessage(errorMsg);
  }
};
