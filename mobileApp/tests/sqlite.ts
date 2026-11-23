import { Database } from "bun:sqlite";
import type { Db, Param } from "../src/db/types";

/** bun:sqlite implementation of the app's Db interface, for tests. */
export function memoryDb(): Db {
  const sql = new Database(":memory:");
  const db: Db = {
    async run(q: string, p: Param[] = []) {
      const r = sql.query(q).run(...p);
      return { changes: r.changes };
    },
    async all<T>(q: string, p: Param[] = []) {
      return sql.query(q).all(...p) as T[];
    },
    async first<T>(q: string, p: Param[] = []) {
      return (sql.query(q).get(...p) as T) ?? null;
    },
    async exec(q: string) {
      sql.exec(q);
    },
    async tx<T>(fn: () => Promise<T>) {
      sql.exec("BEGIN");
      try {
        const v = await fn();
        sql.exec("COMMIT");
        return v;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db;
}
