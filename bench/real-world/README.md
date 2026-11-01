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
bun bench/real-world/run.ts 100000
```

The runner prints a per-methodology table (requests, elapsed ms, req/s) and a
relative comparison against shared memory.

## Files

- `docker-compose.yml` — MySQL and Redis services for the `mysql`/`redis` methodologies
- `data.ts` — the shared user record shape and seed data
- `seed.ts` — seeds SQLite, MySQL and Redis
- `api.ts` — the Elysia mini API with the four backends
- `worker.ts` — a benchmark worker (one Elysia instance, its share of requests)
- `run.ts` — the runner: spawns 4 workers per methodology, distributes requests
