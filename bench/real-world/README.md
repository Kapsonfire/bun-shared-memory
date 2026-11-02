# Real-world benchmark

Compares four methodologies for serving a "get user" request through an
[Elysia](https://elysiajs.com) mini API:

| Methodology | Backend |
|-------------|---------|
| `shared`    | Shared memory (`bun-shared-memory`) |
| `sqlite`    | Live read from a SQLite database |
| `mysql`     | Live read from a MySQL database (Docker) via Bun's native SQL client |
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

> **Note (MySQL auth):** MySQL 8.4 defaults to the `caching_sha2_password`
> auth plugin, which Bun's native SQL client cannot use over an insecure
> connection ("server requested RSA public key retrieval"). If `seed.ts`
> fails with that error, switch the `bench` user to `mysql_native_password`:
>
> ```sh
> docker exec bun-shared-memory-mysql sh -c \
>   'printf "[mysqld]\nmysql_native_password=ON\n" > /etc/mysql/conf.d/native-password.cnf'
> docker restart bun-shared-memory-mysql
> docker exec bun-shared-memory-mysql mysql -uroot -proot -e \
>   "ALTER USER 'bench'@'%' IDENTIFIED WITH mysql_native_password BY 'bench'; FLUSH PRIVILEGES;"
> ```
>
> The config file lives inside the container, so it is lost on
> `docker compose down`/`up` and must be re-applied after recreating the
> container.

## Run

```sh
# Optional: number of requests per methodology (default 100_000).
bun bench/real-world/run.ts 100000
```

The runner prints a per-methodology table (requests, elapsed ms, req/s) sorted
by speed (fastest first) and a relative comparison against shared memory. It
also writes the full results to `benchlogs/<timestamp>-<commit>-real.md` (one
file per run, following the same convention as the micro benchmarks).

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
- **Unix socket** — connects via the Unix sockets mounted from `./sockets`
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
