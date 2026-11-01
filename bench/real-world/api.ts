/**
 * Elysia mini API for the real-world benchmark.
 *
 * Exposes a single endpoint `GET /user/:id` that returns a user record. The
 * backing store is selected at construction time:
 *
 *   - "shared"  — reads from shared memory (bun-shared-memory)
 *   - "sqlite"  — reads live from a SQLite database
 *   - "mysql"   — reads live from a MySQL database
 *   - "redis"   — reads live from a Redis database
 *
 * The benchmark never starts an HTTP server. Instead it builds a `Request`
 * object by hand and calls `app.fetch(request)` directly, which runs the
 * route handler without any network I/O.
 */
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import mysql from "mysql2/promise";
import Redis from "ioredis";
import { Shared } from "../../src/index.ts";
import type { User } from "./data.ts";
import { REDIS_KEY_PREFIX } from "./data.ts";

export type Methodology = "shared" | "sqlite" | "mysql" | "redis";

const SQLITE_PATH = new URL("./bench.db", import.meta.url).pathname;

/** Shared-memory key under which the user record is stored. */
const SHARED_KEY = "real-world:user";

export interface ApiOptions {
  methodology: Methodology;
  /** Shared-memory options (only used for "shared"). */
  shared?: {
    initialSize?: number;
    maxByteLength?: number;
  };
}

/**
 * Build an Elysia app for the given methodology. Each worker creates its own
 * instance so the benchmark can run the methodologies independently.
 */
export function buildApi(opts: ApiOptions) {
  const { methodology } = opts;

  // --- Backend setup -------------------------------------------------------
  let sharedRef: ReturnType<typeof Shared<User>> | null = null;
  let sqlite: Database | null = null;
  let mysqlConn: mysql.Connection | null = null;
  let redis: Redis | null = null;

  if (methodology === "shared") {
    // The main thread seeds the shared value before spawning workers; here we
    // just obtain a reference to it (Shared() never overwrites an existing
    // value, so this reads the main thread's record).
    sharedRef = Shared<User>(SHARED_KEY, {
      id: 0,
      name: "",
      email: "",
      role: "",
      active: false,
      score: 0,
    });
  } else if (methodology === "sqlite") {
    sqlite = new Database(SQLITE_PATH, { readonly: true });
  } else if (methodology === "mysql") {
    // Lazily connect on first request so worker startup is not blocked by the
    // network handshake.
  } else if (methodology === "redis") {
    // Lazily connect on first request so worker startup is not blocked by the
    // network handshake.
  }

  const app = new Elysia().get("/user/:id", async ({ params }) => {
    const id = Number(params.id);
    switch (methodology) {
      case "shared": {
        const u = sharedRef!.read();
        return u;
      }
      case "sqlite": {
        const row = sqlite!
          .query(
            "SELECT id, name, email, role, active, score FROM users WHERE id = ?",
          )
          .get(id) as
          | { id: number; name: string; email: string; role: string; active: number; score: number }
          | undefined;
        if (!row) return new Response("not found", { status: 404 });
        return {
          id: row.id,
          name: row.name,
          email: row.email,
          role: row.role,
          active: row.active === 1,
          score: row.score,
        } satisfies User;
      }
      case "mysql": {
        if (!mysqlConn) {
          mysqlConn = await mysql.createConnection({
            host: "127.0.0.1",
            port: 3306,
            user: "bench",
            password: "bench",
            database: "bench",
          });
        }
        const [rows] = await mysqlConn.execute<mysql.RowDataPacket[]>(
          "SELECT id, name, email, role, active, score FROM users WHERE id = ?",
          [id],
        );
        const row = rows[0] as
          | { id: number; name: string; email: string; role: string; active: number; score: number }
          | undefined;
        if (!row) return new Response("not found", { status: 404 });
        return {
          id: row.id,
          name: row.name,
          email: row.email,
          role: row.role,
          active: row.active === 1,
          score: row.score,
        } satisfies User;
      }
      case "redis": {
        if (!redis) {
          redis = new Redis({ host: "127.0.0.1", port: 6379 });
        }
        const raw = await redis.get(`${REDIS_KEY_PREFIX}${id}`);
        if (!raw) return new Response("not found", { status: 404 });
        return JSON.parse(raw) as User;
      }
    }
  });

  return app;
}

/** The shared-memory key used by the API. */
export const SHARED_USER_KEY = SHARED_KEY;
