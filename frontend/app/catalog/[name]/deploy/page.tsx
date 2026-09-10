import { apiFetch } from "@/lib/api-server";
import { demoNamespaceFor, isDemoEmail, withDemoSuffix } from "@/lib/demo";
import { roleFromGroups } from "@/lib/role";
import { KubeTermsDefault } from "@/components/KubeTermsDefault";
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

  const me = await apiFetch("/v1/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // Computed on the server so SSR and hydration render the same value.
  const defaultName =
    isDemoEmail(me?.email) && !updateReleaseId ? withDemoSuffix(name, true) : "";
  // Only a new release has a namespace field; an update cannot move one.
  const demoNamespace = updateReleaseId ? undefined : demoNamespaceFor(me?.email);

  return (
    <>
      {/* Admins start with raw k8s terms, users with plain words (#39). */}
      <KubeTermsDefault isAdmin={roleFromGroups(me?.groups ?? null) === "admin"} />
      <DeployClient
        templateName={name}
        version={t.current_version}
        team={t.owning_team_name}
        spec={spec}
        updateReleaseId={updateReleaseId}
        defaultName={defaultName}
        demoNamespace={demoNamespace}
      />
    </>
  );
}
