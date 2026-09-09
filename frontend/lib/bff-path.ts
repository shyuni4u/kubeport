/**
 * Build the upstream URL for the `/api/v1/[...path]` proxy, or null when the
 * segments are not something we are willing to forward.
 *
 * Next hands a catch-all route its segments already decoded, so a raw HTTP
 * client sending `%2e%2e` puts a literal `..` in the array — and `fetch()`'s
 * URL parser then collapses it, walking the request out of the `/v1` prefix.
 * That is the same class of bug as the backend's OpenAPI proxy (#11), which is
 * why the shape of the fix matches: reject the segment, then assert the
 * assembled URL still starts with the prefix.
 *
 * Today the blast radius is small — the Go backend only serves `/healthz` and
 * `/v1/*`, and everything under `/v1` sits behind `requireAuth` with the same
 * Authorization header attached. It stops being small the first time an
 * unauthenticated route is added.
 */
const REJECTED_SEGMENTS = new Set(["", ".", ".."]);

export function upstreamUrl(base: string, path: string[], search: string): string | null {
  if (path.some((s) => REJECTED_SEGMENTS.has(s) || s.includes("/") || s.includes("\\"))) {
    return null;
  }

  const prefix = `${base}/v1/`;
  const url = `${prefix}${path.join("/")}${search}`;

  // Second line of defence: compare what a URL parser makes of it, which is
  // what fetch() will actually request.
  try {
    if (!new URL(url).toString().startsWith(new URL(prefix).toString())) return null;
  } catch {
    // Unparseable base or path — refuse rather than hand it to fetch().
    return null;
  }
  return url;
}
