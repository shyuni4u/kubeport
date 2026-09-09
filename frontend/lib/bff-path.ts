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

/**
 * What an inbound request id has to look like to be adopted. Matches the
 * backend's rule exactly.
 *
 * A length cap alone is not enough: header values may contain spaces and `=`,
 * so `z status=200 user=admin@example.com` fits in 64 characters and forges
 * fields inside the access-log line. Since this proxy forwards the header on,
 * anything it accepts reaches the backend's log too.
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The id that ties a request to the backend's access log and to the
 * `request_id` in any Problem the user is looking at.
 *
 * An inbound value is kept so a caller's own trace survives this hop — the
 * backend's requestID middleware says it honours one, and it never saw it
 * while the proxy forwarded only Authorization and Content-Type.
 */
export function requestIdFor(headers: Headers): string {
  const inbound = headers.get("x-request-id");
  if (inbound && REQUEST_ID.test(inbound)) return inbound;
  return crypto.randomUUID();
}

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
