import { router } from "expo-router";

export function openImage(url: string | null | undefined, opts: { cacheKey?: string | null; title?: string } = {}) {
  if (!url) return;
  router.push({ pathname: "/viewer", params: { url, cacheKey: opts.cacheKey ?? "", title: opts.title ?? "" } });
}
