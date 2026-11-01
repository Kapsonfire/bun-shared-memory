/**
 * Seed data for the real-world benchmark.
 *
 * Defines a single shared "user" record shape that is stored in all three
 * backends (shared memory, SQLite, MySQL) so the benchmark compares like for
 * like. The record is a small object with a handful of fields — the kind of
 * thing a real API would fetch per request.
 */
export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  score: number;
}

/** The single user record used by the benchmark. */
export const USER: User = {
  id: 1,
  name: "Alice Example",
  email: "alice@example.com",
  role: "admin",
  active: true,
  score: 42,
};

/** Number of rows to seed into SQLite/MySQL (only one is read per request). */
export const SEED_ROWS = 1000;

/** Build a user row for a given id (used to seed the DBs). */
export function makeUser(id: number): User {
  return {
    id,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    role: id % 2 === 0 ? "admin" : "user",
    active: id % 3 !== 0,
    score: id * 7,
  };
}
