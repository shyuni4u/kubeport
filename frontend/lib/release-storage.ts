/**
 * What deleting a release does to its storage (#340), as the backend reads it
 * from the cluster: `storage_on_delete` on
 * `GET /v1/releases/{id}?include=storage_on_delete`.
 *
 * - `deleted`: a StatefulSet of the release deletes its claims with it
 *   (`whenDeleted: Delete`), or the release holds claims the delete removes.
 * - `kept`: the release has StatefulSets with claims, none of which deletes
 *   them.
 * - `none`: nothing of the release holds storage.
 * - `unknown`: nothing could tell — the delete may still remove storage, so
 *   the confirmation says it may.
 *
 * It is read from the cluster rather than from the last manifest, because an
 * update does not prune: a StatefulSet a later version dropped is still there,
 * and the delete still removes it and its claims.
 */
export type ReleaseStorage = "none" | "deleted" | "kept" | "unknown";

/** Any value but the four the API documents reads as `unknown`. */
export function releaseStorage(value: unknown): ReleaseStorage {
  return value === "deleted" || value === "kept" || value === "none" || value === "unknown"
    ? value
    : "unknown";
}

/**
 * Asks the backend as the delete confirmation opens — not with the detail's own
 * periodic refresh, which would spend cluster calls on every tick. A failed
 * request is `unknown`: a warning that may be unneeded beats none.
 */
export async function fetchStorageOnDelete(releaseId: string): Promise<ReleaseStorage> {
  try {
    const res = await fetch(`/api/v1/releases/${releaseId}?include=storage_on_delete`);
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { storage_on_delete?: unknown };
    return releaseStorage(body.storage_on_delete);
  } catch {
    return "unknown";
  }
}
