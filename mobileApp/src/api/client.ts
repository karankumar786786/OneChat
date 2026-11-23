import createClient, { type Middleware } from "openapi-fetch";
import type { paths, components } from "./schema";
import { API_BASE } from "../config";
import { useAuth } from "../auth/store";
import { fetchWithTimeout } from "../lib/fetch";

export type Schemas = components["schemas"];
export type PublicUser = Schemas["PublicUser"];
export type Me = Schemas["Me"];

export const api = createClient<paths>({ baseUrl: API_BASE, fetch: (req: Request) => fetchWithTimeout(req) });

const pending = new Map<string, Request>();

const auth: Middleware = {
  async onRequest({ request, id }) {
    if (request.url.includes("/auth/")) return request;
    const token = await useAuth.getState().getFreshAccessToken();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    pending.set(id, request.clone());
    return request;
  },
  // Returns undefined to leave the response alone. openapi-fetch only accepts a returned
  // value that is `instanceof Response`, and React Native's fetch hands back a different
  // Response class, so the response it gave us must never be returned as-is.
  async onResponse({ response, id }) {
    const original = pending.get(id);
    pending.delete(id);
    if (response.status !== 401 || !original) return undefined;

    const code = await response
      .clone()
      .json()
      .then((b: { error?: { code?: string } }) => b.error?.code)
      .catch(() => undefined);
    if (code === "TOKEN_EXPIRED") {
      const token = await useAuth.getState().refresh();
      if (token) {
        const retry = new Request(original, { headers: new Headers(original.headers) });
        retry.headers.set("Authorization", `Bearer ${token}`);
        const res = await fetchWithTimeout(retry);
        return new Response(await res.text(), { status: res.status, statusText: res.statusText, headers: res.headers });
      }
    }
    if (code === "SESSION_REVOKED" || code === "UNAUTHORIZED" || code === "TOKEN_EXPIRED") {
      await useAuth.getState().signOut({ remote: false });
    }
    return undefined;
  },
};
api.use(auth);

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Unwraps an openapi-fetch result, throwing ApiError with the server's error code. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (error || !response.ok) {
    const e = (error as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(response.status, e?.code ?? "UNKNOWN", e?.message ?? `Request failed (${response.status})`);
  }
  return data as T;
}
