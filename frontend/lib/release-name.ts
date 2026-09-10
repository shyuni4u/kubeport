/**
 * What the deploy form accepts as a release name (#182).
 *
 * The API is looser: it takes any RFC 1123 hostname that is also a Kubernetes
 * label value, uppercase and dots included (backend/internal/api/releases.go
 * binding, release_ownership.go). The form holds to what its own help text has
 * always promised — a DNS-1123 label: lowercase letters, digits and hyphens,
 * starting and ending with a letter or digit. Stricter than the server costs a
 * visitor nothing they would miss, and keeps one rule on screen instead of a
 * sentence that says one thing and a check that allows another.
 */
export const RELEASE_NAME_MAX_LENGTH = 63;

const RELEASE_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type ReleaseNameProblem = "empty" | "tooLong" | "format";

export function releaseNameProblem(name: string): ReleaseNameProblem | null {
  if (name.trim() === "") return "empty";
  // Checked before the format so a long but otherwise valid name gets the
  // advice that actually fixes it. The input's maxLength stops typing past
  // it, but not a prefilled value.
  if (name.length > RELEASE_NAME_MAX_LENGTH) return "tooLong";
  if (!RELEASE_NAME_RE.test(name)) return "format";
  return null;
}
