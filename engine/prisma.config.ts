import { defineConfig, env } from "prisma/config";

// The Prisma CLI does not read .env by itself; `bun run` does, but direct CLI calls need this.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file: rely on the real environment.
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
