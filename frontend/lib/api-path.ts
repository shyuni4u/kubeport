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
