import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import { API_BASE } from "../config";
import type { components } from "../api/schema";

type Me = components["schemas"]["Me"];
type Tokens = components["schemas"]["Tokens"];

const KEY = "chat.auth.v1";

interface Persisted {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  me: Me;
}

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  me: Me | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  /** Set when the server signed this device out, so the login screen can explain why. */
  signedOutReason: string | null;

  hydrate(): Promise<void>;
  setSession(me: Me, tokens: Tokens): Promise<void>;
  setMe(me: Me): Promise<void>;
  getFreshAccessToken(): Promise<string | null>;
  refresh(): Promise<string | null>;
  signOut(opts?: { remote?: boolean; reason?: string }): Promise<void>;
}

let inflight: Promise<string | null> | null = null;

async function persist(s: Pick<AuthState, "accessToken" | "accessTokenExpiresAt" | "refreshToken" | "me">) {
  if (!s.accessToken || !s.refreshToken || !s.me || !s.accessTokenExpiresAt) {
    await SecureStore.deleteItemAsync(KEY);
    return;
  }
  const value: Persisted = {
    accessToken: s.accessToken,
    accessTokenExpiresAt: s.accessTokenExpiresAt,
    refreshToken: s.refreshToken,
    me: s.me,
  };
  await SecureStore.setItemAsync(KEY, JSON.stringify(value));
}

export const useAuth = create<AuthState>((set, get) => ({
  status: "loading",
  me: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  refreshToken: null,
  signedOutReason: null,

  async hydrate() {
    const raw = await SecureStore.getItemAsync(KEY).catch(() => null);
    if (!raw) return set({ status: "signedOut" });
    try {
      const p = JSON.parse(raw) as Persisted;
      set({ ...p, status: "signedIn" });
    } catch {
      set({ status: "signedOut" });
    }
  },

  async setSession(me, tokens) {
    const next = {
      me,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshToken: tokens.refreshToken,
    };
    set({ ...next, status: "signedIn", signedOutReason: null });
    await persist(next);
  },

  async setMe(me) {
    set({ me });
    await persist({ ...get(), me });
  },

  async getFreshAccessToken() {
    const { accessToken, accessTokenExpiresAt } = get();
    if (!accessToken || !accessTokenExpiresAt) return null;
    // Refresh a little early so requests never race the expiry.
    if (new Date(accessTokenExpiresAt).getTime() - Date.now() > 30_000) return accessToken;
    return get().refresh();
  },

  /** Single-flight: refresh tokens are one-time-use, so two parallel refreshes would sign the user out. */
  refresh() {
    inflight ??= (async () => {
      const refreshToken = get().refreshToken;
      if (!refreshToken) return null;
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (res.status === 401) {
          await get().signOut({ remote: false, reason: "Your session ended. Please sign in again." });
          return null;
        }
        if (!res.ok) return null; // network/server trouble: keep the session and try later
        const { tokens } = (await res.json()) as { tokens: Tokens };
        set({
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          refreshToken: tokens.refreshToken,
        });
        await persist(get());
        return tokens.accessToken;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  async signOut(opts = {}) {
    const { accessToken } = get();
    if (opts.remote !== false && accessToken) {
      await fetch(`${API_BASE}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }).catch(() => {});
    }
    set({
      status: "signedOut",
      me: null,
      accessToken: null,
      accessTokenExpiresAt: null,
      refreshToken: null,
      signedOutReason: opts.reason ?? null,
    });
    await SecureStore.deleteItemAsync(KEY).catch(() => {});
  },
}));
