/**
 * fetch with a deadline, so a request to an unreachable server fails instead of spinning forever.
 * (Built with AbortController + setTimeout, which every React Native version supports.)
 */
export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, ms = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`No answer from the server after ${Math.round(ms / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
