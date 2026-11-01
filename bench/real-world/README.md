# Real-world benchmark

Compares four methodologies for serving a "get user" request through an
[Elysia](https://elysiajs.com) mini API:

| Methodology | Backend |
|-------------|---------|
| `shared`    | Shared memory (`bun-shared-memory`) |
| `sqlite`    | Live read from a SQLite database |
| `mysql`     | Live read from a MySQL database (Docker) |
| `redis`     | Live read from a Redis database (Docker) |

The benchmark does **not** send real HTTP requests. A `Request` object is built
by hand and passed directly to `app.fetch()`, which runs the route handler
without any network I/O. Each methodology is benchmarked **sequentially**; for
each one, **4 workers** are spawned and the total request count is split evenly
across them. Each worker builds its own Elysia instance and processes its share
of the requests.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.4.0
- [Docker](https://www.docker.com) (for the MySQL and Redis methodologies)

## Setup

```sh
bun install

# Start MySQL and Redis, and wait for them to become healthy.
docker compose -f bench/real-world/docker-compose.yml up -d

# Seed SQLite, MySQL and Redis with the benchmark data.
bun bench/real-world/seed.ts
```

## Run

```sh
# Optional: number of requests per methodology (default 100_000).
# Optional: transport for MySQL/Redis — "tcp" (default) or "socket".
bun bench/real-world/run.ts 100000 tcp
```

The runner prints a per-methodology table (requests, elapsed ms, req/s) sorted
by speed (fastest first) and a relative comparison against shared memory. It
also writes the full results to `benchlogs/<timestamp>-<commit>-real.md` (one
file per run, following the same convention as the micro benchmarks).

### Fair comparison

MySQL and Redis connections are **opened once per worker and reused** for all
requests (lazily on the first request) — they are **not** re-established per
request. Each of the 4 workers holds its own persistent connection, so the
measured cost is the actual query/read over an established connection, not the
connection handshake. This keeps the comparison fair against shared memory,
which also has no per-request setup cost.

### Transport: TCP vs Unix socket

MySQL and Redis can be reached over TCP or a Unix socket:

- **`tcp`** (default) — connects to `127.0.0.1:3306` / `127.0.0.1:6379`.
- **`socket`** — connects via the Unix sockets mounted from `./sockets`
  (`sockets/mysql/mysqld.sock`, `sockets/redis/redis.sock`).

> **Note:** the `socket` transport only works on **Linux**, where Docker runs
> natively and container Unix sockets are reachable from the host. On
> macOS/Windows, Docker Desktop runs in a VM and cannot expose container Unix
> sockets to the host, so the runner throws a clear error instead of hanging.

## Files

- `docker-compose.yml` — MySQL and Redis services for the `mysql`/`redis` methodologies
- `data.ts` — the shared user record shape and seed data
- `seed.ts` — seeds SQLite, MySQL and Redis
- `api.ts` — the Elysia mini API with the four backends
- `worker.ts` — a benchmark worker (one Elysia instance, its share of requests)
- `run.ts` — the runner: spawns 4 workers per methodology, distributes requests
