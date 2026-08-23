/**
 * SQLite-backed response cache. Overpass and DataSF are both slow and rate
 * limited, and elevation lookups are the same terrain every time — so every
 * upstream fetch goes through here first.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });

export const db = new Database("data/sanbu.sqlite", { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key        TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS elevation (
    cell TEXT PRIMARY KEY,
    ele  REAL NOT NULL
  );
`);

const getStmt = db.query<{ body: string; fetched_at: number }, [string]>(
  "SELECT body, fetched_at FROM cache WHERE key = ?",
);
const putStmt = db.query<unknown, [string, string, number]>(
  "INSERT INTO cache (key, body, fetched_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
);

export function cacheGet<T>(key: string, maxAgeMs: number): T | null {
  const row = getStmt.get(key);
  if (!row) return null;
  if (Date.now() - row.fetched_at > maxAgeMs) return null;
  try {
    return JSON.parse(row.body) as T;
  } catch {
    return null;
  }
}

export function cachePut(key: string, value: unknown): void {
  putStmt.run(key, JSON.stringify(value), Date.now());
}

/** Fetch through the cache. `maxAgeMs` of 0 forces a refresh. */
export async function cached<T>(
  key: string,
  maxAgeMs: number,
  produce: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key, maxAgeMs);
  if (hit !== null) return hit;
  const fresh = await produce();
  cachePut(key, fresh);
  return fresh;
}

const eleGet = db.query<{ ele: number }, [string]>("SELECT ele FROM elevation WHERE cell = ?");
const elePut = db.query<unknown, [string, number]>(
  "INSERT INTO elevation (cell, ele) VALUES (?, ?) ON CONFLICT(cell) DO NOTHING",
);

export function elevationGet(cell: string): number | null {
  return eleGet.get(cell)?.ele ?? null;
}

export function elevationPutMany(rows: Array<[string, number]>): void {
  const tx = db.transaction((batch: Array<[string, number]>) => {
    for (const [cell, ele] of batch) elePut.run(cell, ele);
  });
  tx(rows);
}
