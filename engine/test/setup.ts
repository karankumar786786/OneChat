/**
 * Runs once before the test files: makes sure the chat_test database exists and is
 * migrated, and empties it and the test Redis db so every run starts clean.
 */
import { SQL } from "bun";
import { Redis } from "ioredis";

const url = new URL(process.env.DATABASE_URL!);
const dbName = url.pathname.slice(1);
if (!dbName.endsWith("_test")) throw new Error(`Refusing to run tests against ${dbName}`);

const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const admin = new SQL(adminUrl.toString());
const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
if (exists.length === 0) await admin.unsafe(`CREATE DATABASE "${dbName}"`);
await admin.close();

const migrate = Bun.spawnSync(["./node_modules/.bin/prisma", "migrate", "deploy"], {
  env: { ...process.env },
  stdout: "pipe",
  stderr: "pipe",
});
if (migrate.exitCode !== 0) {
  throw new Error(`prisma migrate deploy failed:\n${migrate.stderr.toString()}${migrate.stdout.toString()}`);
}

const db = new SQL(url.toString());
const tables = await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
if (tables.length) await db.unsafe(`TRUNCATE ${tables.map((t: { tablename: string }) => `"${t.tablename}"`).join(", ")} CASCADE`);
await db.close();

const redis = new Redis(process.env.REDIS_URL!);
await redis.flushdb();
await redis.quit();
