import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  CORS_ORIGINS: z.string().default("*"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("ap-south-1"),
  S3_ENDPOINT: z.string().optional().transform((v) => (v ? v : undefined)),
  S3_FORCE_PATH_STYLE: bool,

  FILE_TTL_DAYS: z.coerce.number().int().positive().default(30),
  STATUS_TTL_HOURS: z.coerce.number().positive().default(24),
  MAX_FILE_MB: z.coerce.number().positive().default(100),

  EXPO_ACCESS_TOKEN: z.string().optional().transform((v) => (v ? v : undefined)),
  /** Set to false to run the HTTP/socket server without the BullMQ workers (e.g. a dedicated worker process). */
  RUN_WORKERS: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
