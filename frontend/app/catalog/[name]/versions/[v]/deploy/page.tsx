import { apiFetch } from "@/lib/api-server";
import { isDemoEmail, withDemoSuffix } from "@/lib/demo";
import { notFound, redirect } from "next/navigation";
import YAML from "yaml";

import { DeployClient } from "../../../deploy/DeployClient";
import { UpdateValuesUnavailable } from "@/components/UpdateValuesUnavailable";
import { keptSecretPaths, type UISpec } from "@/lib/ui-spec-to-zod";
import { decodeRouteParam, readReleaseForUpdate, updateDeployPath } from "@/lib/update-release";

// Version-pinned deploy route.
// Used by the UpdateAvailableBadge on the release detail page to re-deploy
// an existing release on a new template version
// (`?updateReleaseId=<uuid>`). When `updateReleaseId` is present we fetch the
// release's `values_json` and hand it to DeployClient as `initialValues` so
// the form starts populated with the existing release's values.

export default async function VersionPinnedDeployPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string; v: string }>;
  searchParams: Promise<{ updateReleaseId?: string }>;
}) {
  const { name, v } = await params;
  const { updateReleaseId } = await searchParams;

  const version = Number(v);
  if (!Number.isFinite(version) || !Number.isInteger(version) || version <= 0) {
    notFound();
  }

  const verRes = await apiFetch(`/v1/templates/${name}/versions/${version}`);
  if (!verRes.ok) notFound();
  const ver = (await verRes.json()) as {
    ui_spec_yaml?: string;
    owning_team_name?: string | null;
  };
  if (!ver.ui_spec_yaml) notFound();

  const spec = (YAML.parse(ver.ui_spec_yaml) as UISpec | undefined) ?? {
    fields: [],
  };

  // An update starts from the release's values, or does not start (#296).
  // This read used to be "non-blocking": on a failure the page rendered the
  // form from ui-spec defaults, still as an update, and submitting it
  // overwrote the running Secrets with those defaults. 403/404 were refused by
  // the PUT anyway, so the real trigger was a transient 5xx on this GET.
  let initialValues: Record<string, unknown> | undefined;
  let reenterSecrets: string[] | undefined;
  if (updateReleaseId !== undefined) {
    const read = await readReleaseForUpdate(apiFetch, updateReleaseId, name);
    if (read.kind === "not-found") notFound();
    if (read.kind === "sign-in") {
      redirect(
        `/?next=${encodeURIComponent(updateDeployPath(decodeRouteParam(name), version, updateReleaseId))}`,
      );
    }
    if (read.kind === "unavailable") {
      return <UpdateValuesUnavailable releaseId={updateReleaseId} />;
    }
    initialValues = read.values;
    // A Secret reads back redacted (#196), and only an update on the same
    // version can keep it: moving version needs it entered again. Those
    // fields start empty — not from the placeholder, nor from a ui-spec
    // default the form would otherwise fill in — and must be filled.
    if (read.version !== version) {
      const kept = keptSecretPaths(initialValues);
      initialValues = Object.fromEntries(
        Object.entries(initialValues).filter(([path]) => !kept.has(path)),
      );
      reenterSecrets = [...kept];
    }
  }

  const me = await apiFetch("/v1/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // Computed on the server so SSR and hydration render the same value.
  const defaultName =
    isDemoEmail(me?.email) && !updateReleaseId ? withDemoSuffix(name, true) : "";

  // The terms switch's starting value comes from KubeTermsProvider in the
  // root shell (#39, #247).
  return (
    <DeployClient
      templateName={name}
      version={version}
      team={ver.owning_team_name ?? null}
      spec={spec}
      updateReleaseId={updateReleaseId}
      initialValues={initialValues}
      reenterSecrets={reenterSecrets}
      defaultName={defaultName}
    />
  );
}
