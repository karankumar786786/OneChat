import Constants from "expo-constants";

/**
 * Where the engine runs.
 *
 * In development the engine runs on the same computer as Metro, so the app uses the host it
 * was loaded from (Expo's `hostUri`), on port 4000. That follows your network automatically:
 * the iOS simulator gets 127.0.0.1, a phone that scanned the QR gets your computer's current IP.
 *
 * Set EXPO_PUBLIC_API_URL (in mobileApp/.env, or at build time) to override, e.g. for production.
 */
const ENGINE_PORT = 4000;

function devHostUrl(): string | null {
  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.105:8081"
  const host = hostUri?.split(":")[0];
  return host ? `http://${host}:${ENGINE_PORT}` : null;
}

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || devHostUrl() || `http://localhost:${ENGINE_PORT}`).replace(/\/$/, "");
export const API_BASE = `${API_URL}/api/v1`;
