import { init, Shared } from "../../src/index.ts";
import { join } from "node:path";

const WORKER_COUNT = 4;
const API_PORT = 3001;

type SharedTodos = {
  nextId: number;
  items: string;
};

// Set up the shared-memory handshake and seed the shared todo store on the
// main thread. Workers receive these buffers via `await init()`.
await init({ initialSize: 64 * 1024, maxByteLength: 512 * 1024 * 1024 });
Shared<SharedTodos>("todos", { nextId: 1, items: "[]" });

// Spawn 4 Elysia listener workers. All share the same port via `reusePort`
// and the same todo store through bun-shared-memory.
const workers: Worker[] = [];
for (let i = 0; i < WORKER_COUNT; i++) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    env: { ...process.env, PORT: String(API_PORT) },
  });
  workers.push(worker);
}

// Serve the static frontend from the main thread.
const staticApp = Bun.serve({
  port: 3000,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(
        Bun.file(join(import.meta.dir, "public", "index.html")),
      );
    }
    if (url.pathname === "/styles.css") {
      return new Response(
        Bun.file(join(import.meta.dir, "public", "styles.css")),
      );
    }
    if (url.pathname === "/app.js") {
      return new Response(Bun.file(join(import.meta.dir, "public", "app.js")));
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`🦊 Todo list frontend at http://localhost:${staticApp.port}`);
console.log(
  `🦊 ${WORKER_COUNT} API workers sharing port ${API_PORT} (reusePort)`,
);

// Keep the process alive.
process.on("SIGINT", () => {
  for (const w of workers) w.terminate();
  process.exit(0);
});
