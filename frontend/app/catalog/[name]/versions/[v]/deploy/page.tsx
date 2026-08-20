import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import YAML from "yaml";

import { DeployClient } from "../../../deploy/DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";

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

  // Fetch existing release values when re-deploying on a new version.
  // Non-blocking: if the fetch fails (404/403/etc.) we render the form blank
  // rather than failing the whole page. The user can always re-enter values.
  let initialValues: Record<string, unknown> | undefined;
  if (updateReleaseId) {
    const relRes = await apiFetch(`/v1/releases/${updateReleaseId}`);
    if (relRes.ok) {
      const rel = (await relRes.json()) as {
        values_json?: Record<string, unknown>;
      };
      initialValues = rel.values_json;
    }
  }

  return (
    <DeployClient
      templateName={name}
      version={version}
      team={ver.owning_team_name ?? null}
      spec={spec}
      updateReleaseId={updateReleaseId}
      initialValues={initialValues}
    />
  );
}
