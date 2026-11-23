import * as SQLite from "expo-sqlite";
import type { Db, Param } from "./types";
import { migrate } from "./schema";

/** One database file per account, so signing into another account never mixes histories. */
let current: { userId: string; db: Db; raw: SQLite.SQLiteDatabase } | null = null;

function wrap(raw: SQLite.SQLiteDatabase): Db {
  return {
    async run(sql: string, params: Param[] = []) {
      const r = await raw.runAsync(sql, params);
      return { changes: r.changes };
    },
    all: <T,>(sql: string, params: Param[] = []) => raw.getAllAsync<T>(sql, params),
    first: <T,>(sql: string, params: Param[] = []) => raw.getFirstAsync<T>(sql, params),
    exec: (sql: string) => raw.execAsync(sql),
    async tx<T>(fn: () => Promise<T>) {
      let out!: T;
      await raw.withExclusiveTransactionAsync(async () => {
        out = await fn();
      });
      return out;
    },
  };
}

export async function openUserDb(userId: string): Promise<Db> {
  if (current?.userId === userId) return current.db;
  if (current) await current.raw.closeAsync().catch(() => {});
  const raw = await SQLite.openDatabaseAsync(`chat-${userId}.db`);
  const db = wrap(raw);
  await migrate(db);
  current = { userId, db, raw };
  return db;
}

export function getDb(): Db {
  if (!current) throw new Error("Local database is not open");
  return current.db;
}

export async function closeUserDb() {
  if (current) await current.raw.closeAsync().catch(() => {});
  current = null;
}
