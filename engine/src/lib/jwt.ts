import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { env } from "../config/env.ts";
import { unauthorized } from "./errors.ts";

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = "chat-engine";

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session id */
  sid: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw unauthorized("Malformed token");
    }
    return { sub: payload.sub, sid: payload.sid };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw unauthorized("Access token expired", "TOKEN_EXPIRED");
    if (err instanceof joseErrors.JOSEError) throw unauthorized("Invalid access token");
    throw err;
  }
}

/** Opaque refresh tokens: random bytes, only the SHA-256 hash is stored. */
export function newRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
