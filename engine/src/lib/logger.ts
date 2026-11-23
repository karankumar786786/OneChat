import pino from "pino";
import { env } from "../config/env.ts";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "warn" : env.NODE_ENV === "production" ? "info" : "debug",
  redact: ["req.headers.authorization", "password", "refreshToken", "token"],
  ...(env.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : {}),
});
