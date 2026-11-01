/**
 * Seed the SQLite and MySQL databases with the benchmark data.
 *
 * Run once before benchmarking:
 *   bun bench/real-world/seed.ts
 *
 * Requires the MySQL container to be up (see docker-compose.yml).
 */
import { Database } from "bun:sqlite";
import mysql from "mysql2/promise";
import { makeUser, SEED_ROWS } from "./data.ts";

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
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3306,
    user: "bench",
    password: "bench",
    database: "bench",
  });
  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      active TINYINT(1) NOT NULL,
      score INT NOT NULL
    )
  `);
  await conn.query("DELETE FROM users");
  for (let i = 1; i <= SEED_ROWS; i++) {
    const u = makeUser(i);
    await conn.query(
      "INSERT INTO users (id, name, email, role, active, score) VALUES (?, ?, ?, ?, ?, ?)",
      [u.id, u.name, u.email, u.role, u.active ? 1 : 0, u.score],
    );
  }
  await conn.end();
  console.log(`MySQL seeded: ${SEED_ROWS} rows`);
}

await seedSqlite();
await seedMysql();
