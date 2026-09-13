import YAML from "yaml";

/**
 * What deleting a release does to the storage its StatefulSets keep (#340).
 *
 * - `deleted`: a StatefulSet with volumeClaimTemplates has
 *   `persistentVolumeClaimRetentionPolicy.whenDeleted: Delete` — its claims,
 *   and under the usual reclaim policy their data, go with the release. The
 *   backend renders that by default.
 * - `kept`: StatefulSets with claims, none of which deletes them — the
 *   template chose Retain, or the release was last applied before the default.
 * - `none`: no StatefulSet storage, or nothing readable to tell.
 *
 * Read from the manifest the release was last applied with, not from its
 * template, so a release that has not been updated since the default reads as
 * it will actually behave.
 */
export type ReleaseStorage = "none" | "deleted" | "kept";

type StatefulSetShape = {
  kind?: unknown;
  spec?: {
    volumeClaimTemplates?: unknown;
    persistentVolumeClaimRetentionPolicy?: { whenDeleted?: unknown } | null;
  } | null;
};

export function releaseStorage(renderedYaml: string | null | undefined): ReleaseStorage {
  if (!renderedYaml) return "none";
  let kept = false;
  for (const doc of YAML.parseAllDocuments(renderedYaml)) {
    if (doc.errors.length > 0) continue;
    const obj = doc.toJS() as StatefulSetShape | null;
    if (!obj || typeof obj !== "object" || obj.kind !== "StatefulSet") continue;
    const claims = obj.spec?.volumeClaimTemplates;
    if (!Array.isArray(claims) || claims.length === 0) continue;
    // One StatefulSet that deletes is what the reader must hear about, even if
    // another keeps its claims.
    if (obj.spec?.persistentVolumeClaimRetentionPolicy?.whenDeleted === "Delete") return "deleted";
    kept = true;
  }
  return kept ? "kept" : "none";
}
