import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "TOKEN_EXPIRED"
  | "SESSION_REVOKED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "EMAIL_TAKEN"
  | "USERNAME_TAKEN"
  | "USERNAME_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "GONE"
  | "FILE_TOO_LARGE"
  | "RATE_LIMITED"
  | "STORAGE_NOT_CONFIGURED"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Not signed in", code: ErrorCode = "UNAUTHORIZED") =>
  new AppError(401, code, message);
export const forbidden = (message = "Not allowed") => new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found") => new AppError(404, "NOT_FOUND", message);
export const conflict = (code: ErrorCode, message: string) => new AppError(409, code, message);
export const gone = (message: string) => new AppError(410, "GONE", message);
