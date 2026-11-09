# Real-world benchmark

Compares four methodologies for serving a "get user" request through an
[Elysia](https://elysiajs.com) mini API:

| Methodology | Backend                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `shared`    | Shared memory (`bun-shared-memory`)                                    |
| `sqlite`    | Live read from a SQLite database                                       |
| `mysql`     | Live read from a MySQL database (Docker) via Bun's native SQL client   |
| `redis`     | Live read from a Redis database (Docker) via Bun's native Redis client |

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

The compose file starts both services over **TCP**, which works everywhere,
including Docker Desktop on macOS and Windows. It also takes care of two
pitfalls automatically:

- **MySQL 8.4 auth:** MySQL 8.4 disables `mysql_native_password`, but Bun's
  native SQL client cannot use the default `caching_sha2_password` over an
  insecure connection ("server requested RSA public key retrieval" / "Plugin
  'mysql_native_password' is not loaded"). The compose file starts MySQL with
  `--mysql-native-password=ON` and `mysql-init.sql` switches the `bench` user to
  that method when the container is first created.
- **Unix sockets (Linux only):** bind-mounting host directories for Unix sockets
  does not work on Docker Desktop (Redis: "Failed opening Unix socket: bind: Not
  supported", MySQL's entrypoint aborts, so the containers exit immediately).
  The socket mounts therefore live in a separate override file. On Linux, to
  benchmark the socket transport as well:

  ```sh
  docker compose -f bench/real-world/docker-compose.yml \
                 -f bench/real-world/docker-compose.sockets.yml up -d
  ```

  If a previous run left stale files in `bench/real-world/sockets/`, delete that
  directory before starting the containers.

## Run

```sh
# Optional: number of requests per methodology (default 100_000).
bun bench/real-world/run.ts 100000
```

The runner prints a per-methodology table (requests, elapsed ms, req/s) sorted
by speed (fastest first) and a relative comparison against shared memory. It
also writes the full results to `benchlogs/<timestamp>-<commit>-real.md` (one
file per run, following the same convention as the micro benchmarks).

### Stability

The shared-memory methodology is extremely fast (finishes in tens of
milliseconds), so it is sensitive to CPU contention from other processes (the
IDE, language servers, etc.). To get a stable, reproducible number, the runner
takes the **minimum** over several measurements — contention can only slow a
run down, never speed it up, so the minimum is the best estimate of true
throughput:

- **Samples per worker**: each worker runs the full request loop several times
  and reports its fastest sample (15 for `shared`/`sqlite`, 3 for `mysql`/`redis`).
- **Runs per methodology**: each methodology is run several times (each run
  spawns the 4 workers again) and the fastest run is kept (5 for
  `shared`/`sqlite`, 2 for `mysql`/`redis`).

MySQL and Redis answer only ~5 000 requests/s per connection, so the high
counts used for the millisecond-fast methodologies would take 6-7 minutes for
each of them; their numbers are stable with fewer samples, and the whole run
takes a few minutes. The runner prints `1/2 2/2 ...` as each run finishes, so a
slow methodology does not look like a hang. Override the counts for all
methodologies with `BENCH_SAMPLES` and `BENCH_RUNS`, e.g.
`BENCH_SAMPLES=15 BENCH_RUNS=5 bun run bench:real`.

For the most reliable results, close or pause CPU-heavy applications (IDE,
Copilot, language servers) before running.

### Fair comparison

MySQL and Redis connections are **opened once per worker, before the
benchmark runs**, and reused for all requests — they are **not** re-established
per request. Each of the 4 workers holds its own persistent connection, so the
measured cost is the actual query/read over an established connection, not the
connection handshake. This keeps the comparison fair against shared memory,
which also has no per-request setup cost.

### Transport: TCP and Unix socket

MySQL and Redis are benchmarked over **both** transports automatically:

- **TCP** — connects to `127.0.0.1:3306` / `127.0.0.1:6379`.
- **Unix socket** (Linux only, needs `docker-compose.sockets.yml`) — connects via the Unix sockets mounted from `./sockets`
  (`sockets/mysql/mysqld.sock`, `sockets/redis/redis.sock`).

> **Note:** the Unix-socket run is only executed on **Linux**, where Docker
> runs natively and container Unix sockets are reachable from the host. On
> macOS/Windows, Docker Desktop runs in a VM and cannot expose container Unix
> sockets to the host, so the socket run is **skipped without error** (a note
> is printed instead).

## Files

- `docker-compose.yml` — MySQL and Redis services for the `mysql`/`redis` methodologies
- `data.ts` — the shared user record shape and seed data
- `seed.ts` — seeds SQLite, MySQL and Redis
- `api.ts` — the Elysia mini API with the four backends
- `worker.ts` — a benchmark worker (one Elysia instance, its share of requests)
- `run.ts` — the runner: spawns 4 workers per methodology, distributes requests
