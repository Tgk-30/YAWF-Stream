/**
 * Resolves a public asset against the build's mount prefix.
 *
 * The site is served under a path prefix that differs per deployment, for
 * example /debridstreamer/ on tgk30.com and /streamer/ on yawf.com. Vite bakes
 * that prefix into import.meta.env.BASE_URL at build time, so every reference to
 * a file in public/ has to go through here. A hardcoded absolute path such as
 * "/debridstreamer/hero.jpg" resolves to the wrong origin path on every mount
 * except the one it was written for, and 404s.
 *
 * Pass the path as it sits inside public/, with or without a leading slash.
 */
const BASE = import.meta.env.BASE_URL;

export function asset(path: string): string {
  return `${BASE}${path.replace(/^\/+/, '')}`;
}
