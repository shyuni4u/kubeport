/**
 * Reading a release to start an update form from it (#296).
 *
 * An update form has to start from the release's own values. Started from
 * anything less, its Secret fields fill in from ui-spec defaults (`changeme`),
 * the PUT sends them, and the backend's render fills whatever is still missing
 * from the same defaults — so the running Secret is overwritten without a word.
 * The deploy pages used to render that form whenever this read failed.
 *
 * Kept free of `apiFetch` and `next/navigation` so the decision is testable;
 * the pages turn each outcome into notFound(), redirect() or a rendered state.
 */

// What the backend's parseUUID accepts in practice. Checked before the id is
// put into an API path: it comes from the query string, and `../templates/x`
// would otherwise address another endpoint with the caller's token.
const RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReleaseId(value: unknown): value is string {
  return typeof value === "string" && RELEASE_ID.test(value);
}

export type UpdateRead =
  | {
      kind: "ok";
      templateName: string;
      version: number;
      values: Record<string, unknown>;
    }
  /** A malformed id, a release that is gone or not yours, or another template's. */
  | { kind: "not-found" }
  /** The session expired. */
  | { kind: "sign-in" }
  /** Anything else: the values are unknown, so no form may start. */
  | { kind: "unavailable" };

/**
 * A route param, decoded if it still carries percent-encoding. Compared both
 * ways below so the check does not depend on whether the router decoded it.
 */
export function decodeRouteParam(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    return param;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read release `id` for an update of template `templateName`.
 *
 * Statuses follow `releaseReadFailed` (lib/release-read.ts): 400/403/404 are
 * "not found" — 403 included so an id is not confirmed to someone guessing —
 * and 401 is an expired session. Everything else, a network failure, or a
 * body without a template and values is "unavailable" rather than "not found":
 * a hiccup is not an absence, and the reader is offered a retry.
 */
export async function readReleaseForUpdate(
  fetcher: (path: string) => Promise<Response>,
  id: unknown,
  templateName: string,
): Promise<UpdateRead> {
  if (!isReleaseId(id)) return { kind: "not-found" };

  let res: Response;
  try {
    res = await fetcher(`/v1/releases/${id}`);
  } catch {
    return { kind: "unavailable" };
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 403 || res.status === 404) return { kind: "not-found" };
    if (res.status === 401) return { kind: "sign-in" };
    return { kind: "unavailable" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unavailable" };
  }
  const rel = isPlainObject(body) ? body : {};
  const template = isPlainObject(rel.template) ? rel.template : {};
  const name = template.name;
  const version = template.version;
  const values = rel.values_json;
  if (
    typeof name !== "string" ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version <= 0 ||
    !isPlainObject(values)
  ) {
    return { kind: "unavailable" };
  }

  // A release of another template must not be updated through this one's form
  // — its ui-spec would describe other fields and fill the rest with this
  // template's defaults — nor sent on to another template's deploy page.
  if (name !== templateName && name !== decodeRouteParam(templateName)) {
    return { kind: "not-found" };
  }
  return { kind: "ok", templateName: name, version, values };
}

/** The version-pinned update form for a release — the only one that loads its values. */
export function updateDeployPath(templateName: string, version: number, releaseId: string): string {
  return `/catalog/${encodeURIComponent(templateName)}/versions/${version}/deploy?updateReleaseId=${encodeURIComponent(releaseId)}`;
}
