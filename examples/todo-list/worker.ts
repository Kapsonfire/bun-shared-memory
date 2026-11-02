import { Elysia } from "elysia";
import { init, Shared } from "../../src/index.ts";

type Todo = {
  id: number;
  title: string;
  done: boolean;
  createdAt: number;
};

/**
 * The shared value stored in bun-shared-memory. It has a fixed shape:
 * `nextId` is the next todo id, `items` is a JSON-serialized array of todos.
 * All 4 workers read/write this single shared object through the same
 * SharedArrayBuffer, synchronized with Atomics-based locking.
 *
 * `Shared()` returns a proxy object, so we use it like a normal object:
 * `shared.nextId` and `shared.items` read/write shared memory directly.
 */
type SharedTodos = {
  nextId: number;
  items: string;
};

const SHARED_KEY = "todos";

function parseItems(items: string): Todo[] {
  return JSON.parse(items) as Todo[];
}

function buildApi(port: number) {
  // Obtain the shared reference. The main thread seeds it before spawning
  // workers, so this never overwrites the existing value.
  const shared = Shared<SharedTodos>(SHARED_KEY, { nextId: 1, items: "[]" });

  return new Elysia()
    .get("/api/todos", () => {
      return parseItems(shared.items);
    })
    .post("/api/todos", ({ body }) => {
      const title = (body as { title?: string }).title?.trim();
      if (!title) {
        return new Response("title is required", { status: 400 });
      }
      const items = parseItems(shared.items);
      const created: Todo = {
        id: shared.nextId,
        title,
        done: false,
        createdAt: Date.now(),
      };
      items.push(created);
      shared.nextId = shared.nextId + 1;
      shared.items = JSON.stringify(items);
      return created;
    })
    .patch("/api/todos/:id", ({ params, body }) => {
      const id = Number(params.id);
      const { title, done } = body as { title?: string; done?: boolean };
      const items = parseItems(shared.items);
      const todo = items.find((t) => t.id === id);
      if (!todo) {
        return new Response("not found", { status: 404 });
      }
      if (typeof title === "string") {
        const trimmed = title.trim();
        if (!trimmed) {
          return new Response("title must not be empty", { status: 400 });
        }
        todo.title = trimmed;
      }
      if (typeof done === "boolean") {
        todo.done = done;
      }
      shared.items = JSON.stringify(items);
      return todo;
    })
    .delete("/api/todos/:id", ({ params }) => {
      const id = Number(params.id);
      const items = parseItems(shared.items);
      const index = items.findIndex((t) => t.id === id);
      if (index === -1) {
        return new Response("not found", { status: 404 });
      }
      items.splice(index, 1);
      shared.items = JSON.stringify(items);
      return new Response(null, { status: 204 });
    })
    .get("/", () => new Response("Todo worker"))
    .listen({
      port,
      reusePort: true,
    });
}

const port = Number(process.env.PORT ?? 3001);

// Receive the shared buffers from the main thread before using Shared().
await init();
buildApi(port);

console.log(`🦊 Todo worker listening on http://localhost:${port} (reusePort)`);
