import { init, Shared } from "../../src/index.ts";

const WORKER_COUNT = 4;
const PORT = 3000;

type SharedTodos = {
  nextId: number;
  items: string;
};

// Set up the shared-memory handshake and seed the shared todo store on the
// main thread. Workers receive these buffers via `await init()`.
await init({ initialSize: 64 * 1024, maxByteLength: 512 * 1024 * 1024 });
Shared<SharedTodos>("todos", { nextId: 1, items: "[]" });

// Spawn 4 Elysia listener workers. Each serves the frontend AND the API on
// the same port via `reusePort`, sharing the same todo store through
// bun-shared-memory. The main thread hosts nothing.
const workers: Worker[] = [];
for (let i = 0; i < WORKER_COUNT; i++) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    env: { ...process.env, PORT: String(PORT) },
  });
  workers.push(worker);
}

console.log(
  `🦊 ${WORKER_COUNT} workers serving frontend + API on http://localhost:${PORT} (reusePort)`,
);

// Keep the process alive.
process.on("SIGINT", () => {
  for (const w of workers) w.terminate();
  process.exit(0);
});
