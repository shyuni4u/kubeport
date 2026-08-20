import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import YAML from "yaml";

import { DeployClient } from "./DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";

type TemplateDetail = {
  name: string;
  current_version: number | null;
  owning_team_name: string | null;
};

type TemplateVersion = {
  ui_spec_yaml: string;
};

export default async function DeployPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ updateReleaseId?: string }>;
}) {
  const { name } = await params;
  const { updateReleaseId } = await searchParams;

  const tRes = await apiFetch(`/v1/templates/${name}`);
  if (!tRes.ok) notFound();
  const t = (await tRes.json()) as TemplateDetail;
  if (t.current_version == null) notFound();

  const vRes = await apiFetch(
    `/v1/templates/${name}/versions/${t.current_version}`,
  );
  if (!vRes.ok) notFound();
  const v = (await vRes.json()) as TemplateVersion;
  const spec = (YAML.parse(v.ui_spec_yaml) as UISpec | undefined) ?? {
    fields: [],
  };

  return (
    <DeployClient
      templateName={name}
      version={t.current_version}
      team={t.owning_team_name}
      spec={spec}
      updateReleaseId={updateReleaseId}
    />
  );
}
