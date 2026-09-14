/**
 * Building Go API paths out of values a request carries (#374).
 *
 * Next hands a dynamic route its params already decoded
 * (`next/dist/shared/lib/router/utils/route-matcher.js`), and the BFF
 * catch-all its segments the same way. `%2F` and `%2e%2e` arrive as `/` and
 * `..`, and a path assembled from them is collapsed by fetch()'s URL parser
 * onto another `/v1` route — with the caller's own token, so no privilege is
 * gained, but a form on one page can send a DELETE somewhere else.
 *
 * Only what cannot be a single segment is refused. A template name from before
 * #369's rule — uppercase, a space — is still one segment and still opens.
 */
const REJECTED_SEGMENTS = new Set(["", ".", ".."]);

/** Whether a decoded value may stand as one path segment. */
export function isSafePathSegment(segment: string): boolean {
  return !REJECTED_SEGMENTS.has(segment) && !segment.includes("/") && !segment.includes("\\");
}

/** A decoded value as one encoded API path segment, or null when it cannot be one. */
export function apiPathSegment(value: string): string | null {
  return isSafePathSegment(value) ? encodeURIComponent(value) : null;
}

/**
 * A template version from a form field: a positive integer as sent, or null.
 * The field is a hidden input, but a server action takes whatever is posted.
 */
export function versionSegment(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) ? value : null;
}

/**
 * The Go API URL apiFetch requests for `path`, or null when that request would
 * not be for `path` itself under `/v1/` (#374).
 *
 * One check for every server-side call, whatever built the path. A `/v1/`
 * prefix alone is not enough: `/v1/templates/../releases/<id>` still starts
 * with it and fetch() sends it to `/v1/releases/<id>`. So the path the URL
 * parser makes of it has to be the path given — a collapsed `..` or `%2e%2e`,
 * a `\` turned into `/`, or an unencoded character the parser escapes all make
 * the two differ.
 *
 * A raw value that reached the path unencoded can also cut it short without
 * any dot-segment (security review): a `?` or `#` from `%3F`/`%23` ends the
 * path there, so `/v1/teams/T1?x/members` requests `/v1/teams/T1` — another
 * route, with what followed moved into the query. No apiFetch caller sends a
 * query or a fragment, so a path carrying either is refused outright; a caller
 * that needs a query should get its own parameter, kept apart from the path.
 * An empty segment or a trailing `/` is refused too (`/v1/teams/` is redirected
 * by Gin to `/v1/teams`). Gin routes on the decoded path, so a `%2F` or `%5C`
 * would become a separator there; a value encoded with encodeURIComponent
 * carries `%252F`, never `%2F`, so both are refused as well.
 */
export function serverApiUrl(base: string, path: string): string | null {
  if (!path.startsWith("/v1/") || path.includes("?") || path.includes("#")) return null;
  if (path.endsWith("/") || path.includes("//") || /%2f|%5c/i.test(path)) return null;
  let root: URL;
  let parsed: URL;
  try {
    root = new URL(base);
    parsed = new URL(`${base}${path}`);
  } catch {
    return null;
  }
  const basePath = root.pathname.replace(/\/$/, "");
  if (parsed.origin !== root.origin || parsed.pathname !== `${basePath}${path}` || parsed.search !== "") {
    return null;
  }
  return `${base}${path}`;
}
