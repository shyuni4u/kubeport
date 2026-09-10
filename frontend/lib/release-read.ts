import { notFound, redirect } from "next/navigation";

/**
 * What a release page does when `GET /v1/releases/{id}` did not succeed.
 *
 * Every failure used to become notFound(). With a single render that was a
 * rare mislabel; since the detail page re-reads itself while a rollout settles
 * (#183), it is the same branch taken every few seconds — so a transient 5xx,
 * or a demo session reaching its TTL mid-poll, turned the release the reader
 * was watching into "not found".
 *
 * - 400 / 403 / 404 stay "not found": a malformed id, a release that is gone,
 *   or one that is not yours. 403 is folded in on purpose — saying "exists,
 *   but not yours" would confirm an id to someone guessing them.
 * - 401 is an expired session, not a missing release: back to the landing
 *   page, which sends the reader here again once they sign in.
 * - Anything else (5xx, 429) is thrown to the error boundary, which says
 *   something went wrong and offers a retry, instead of claiming absence.
 */
export function releaseReadFailed(status: number, id: string): never {
  if (status === 400 || status === 403 || status === 404) notFound();
  if (status === 401) redirect(`/?next=${encodeURIComponent(`/releases/${id}`)}`);
  throw new Error(`release read failed: HTTP ${status}`);
}
