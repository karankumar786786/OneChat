/**
 * Where the engine runs. Set EXPO_PUBLIC_API_URL in mobileApp/.env:
 * - iOS simulator: http://localhost:4000
 * - Android emulator: http://10.0.2.2:4000
 * - Physical device: http://<your computer's LAN IP>:4000
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const API_BASE = `${API_URL}/api/v1`;
