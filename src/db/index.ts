import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // If a second process (e.g. two concurrent `npm run run-workflow` invocations) holds
  // the write lock, wait up to 5s for it instead of failing immediately with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  const row = db.prepare("SELECT now_ms FROM clock WHERE id = 1").get();
  if (!row) {
    db.prepare("INSERT INTO clock (id, now_ms) VALUES (1, ?)").run(Date.now());
  }

  instance = db;
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Runs fn inside a BEGIN/COMMIT, rolling back on any thrown error. node:sqlite has no built-in helper for this. */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
