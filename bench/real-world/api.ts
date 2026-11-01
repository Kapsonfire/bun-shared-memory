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
import { SQL } from "bun";
import Redis from "ioredis";
import { Shared } from "../../src/index.ts";
import type { User } from "./data.ts";
import { REDIS_KEY_PREFIX } from "./data.ts";

export type Methodology = "shared" | "sqlite" | "mysql" | "redis";

/** How MySQL/Redis are reached: over TCP or a Unix socket. */
export type Transport = "tcp" | "socket";

const SQLITE_PATH = new URL("./bench.db", import.meta.url).pathname;

/** Unix socket paths (mounted from ./sockets in docker-compose). */
const MYSQL_SOCKET = new URL("./sockets/mysql/mysqld.sock", import.meta.url).pathname;
const REDIS_SOCKET = new URL("./sockets/redis/redis.sock", import.meta.url).pathname;

/**
 * Unix sockets over Docker volumes only work when Docker runs natively (Linux).
 * On macOS/Windows, Docker Desktop runs in a VM and the volume sync does not
 * carry real socket connections, so connecting would hang. Throw a clear error
 * instead of silently hanging.
 */
function assertSocketSupported(): void {
  if (process.platform !== "linux") {
    throw new Error(
      `Unix-socket transport is only supported on Linux (got ${process.platform}). ` +
        "Docker Desktop on macOS/Windows runs in a VM and cannot expose container " +
        "Unix sockets to the host. Use the 'tcp' transport instead.",
    );
  }
}

/** Shared-memory key under which the user record is stored. */
const SHARED_KEY = "real-world:user";

export interface ApiOptions {
  methodology: Methodology;
  /** Transport for MySQL/Redis ("tcp" or "socket"). Ignored for shared/sqlite. */
  transport?: Transport;
  /** Shared-memory options (only used for "shared"). */
  shared?: {
    initialSize?: number;
    maxByteLength?: number;
  };
}

/**
 * Build an Elysia app for the given methodology. Each worker creates its own
 * instance so the benchmark can run the methodologies independently.
 *
 * MySQL/Redis connections are established here (before the benchmark runs) so
 * the connection handshake is not counted as per-request overhead.
 */
export async function buildApi(opts: ApiOptions) {
  const { methodology } = opts;
  const transport: Transport = opts.transport ?? "tcp";

  // Only MySQL/Redis use the transport; shared/sqlite ignore it.
  if (transport === "socket" && (methodology === "mysql" || methodology === "redis")) {
    assertSocketSupported();
  }

  // --- Backend setup -------------------------------------------------------
  let sharedRef: ReturnType<typeof Shared<User>> | null = null;
  let sqlite: Database | null = null;
  let mysql: SQL | null = null;
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
    // Establish the connection up front so the handshake is not part of the
    // measured per-request cost. Bun's native SQL client (Bun.SQL) is used
    // with tagged-template queries; Unix sockets are selected via ?socket=.
    mysql = new SQL(
      transport === "socket"
        ? `mysql://bench:bench@127.0.0.1/bench?socket=${MYSQL_SOCKET}`
        : "mysql://bench:bench@127.0.0.1:3306/bench",
    );
  } else if (methodology === "redis") {
    // Establish the connection up front so the handshake is not part of the
    // measured per-request cost.
    redis = new Redis(
      transport === "socket"
        ? { path: REDIS_SOCKET }
        : { host: "127.0.0.1", port: 6379 },
    );
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
        const rows = await mysql!`
          SELECT id, name, email, role, active, score
          FROM users
          WHERE id = ${id}
        ` as {
          id: number;
          name: string;
          email: string;
          role: string;
          active: number;
          score: number;
        }[];
        const row = rows[0];
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
        const raw = await redis!.get(`${REDIS_KEY_PREFIX}${id}`);
        if (!raw) return new Response("not found", { status: 404 });
        return JSON.parse(raw) as User;
      }
    }
  });

  return app;
}

/** The shared-memory key used by the API. */
export const SHARED_USER_KEY = SHARED_KEY;
