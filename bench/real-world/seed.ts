/**
 * Seed the SQLite, MySQL and Redis databases with the benchmark data.
 *
 * Run once before benchmarking:
 *   bun bench/real-world/seed.ts
 *
 * Requires the MySQL and Redis containers to be up (see docker-compose.yml).
 */
import { Database } from "bun:sqlite";
import { SQL, RedisClient } from "bun";
import { makeUser, REDIS_KEY_PREFIX, SEED_ROWS } from "./data.ts";

const SQLITE_PATH = new URL("./bench.db", import.meta.url).pathname;

async function seedSqlite(): Promise<void> {
  const db = new Database(SQLITE_PATH);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL,
      score INTEGER NOT NULL
    )
  `);
  db.run("DELETE FROM users");
  const insert = db.prepare(
    "INSERT INTO users (id, name, email, role, active, score) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (let i = 1; i <= SEED_ROWS; i++) {
      const u = makeUser(i);
      insert.run(u.id, u.name, u.email, u.role, u.active ? 1 : 0, u.score);
    }
  })();
  db.close();
  console.log(`SQLite seeded: ${SEED_ROWS} rows -> ${SQLITE_PATH}`);
}

async function seedMysql(): Promise<void> {
  const mysql = new SQL("mysql://bench:bench@127.0.0.1:3306/bench");
  await mysql`
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      active TINYINT(1) NOT NULL,
      score INT NOT NULL
    )
  `;
  await mysql`DELETE FROM users`;
  for (let i = 1; i <= SEED_ROWS; i++) {
    const u = makeUser(i);
    await mysql`
      INSERT INTO users (id, name, email, role, active, score)
      VALUES (${u.id}, ${u.name}, ${u.email}, ${u.role}, ${u.active ? 1 : 0}, ${u.score})
    `;
  }
  // Prime the connection.
  await mysql`SELECT id FROM users LIMIT 1`;
  mysql.close();
  console.log(`MySQL seeded: ${SEED_ROWS} rows`);
}

async function seedRedis(): Promise<void> {
  const redis = new RedisClient("redis://127.0.0.1:6379");
  await redis.connect();
  // Prime the connection.
  await redis.ping();
  const keys = await redis.keys(`${REDIS_KEY_PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
  // Bulk-insert via MSET (Bun's native client has no pipeline; MSET sets all
  // key/value pairs in a single command).
  const pairs: string[] = [];
  for (let i = 1; i <= SEED_ROWS; i++) {
    pairs.push(`${REDIS_KEY_PREFIX}${i}`, JSON.stringify(makeUser(i)));
  }
  await redis.mset(...pairs);
  redis.close();
  console.log(`Redis seeded: ${SEED_ROWS} rows`);
}

await seedSqlite();
await seedMysql();
await seedRedis();
