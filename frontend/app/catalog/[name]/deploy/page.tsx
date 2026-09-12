import { apiFetch } from "@/lib/api-server";
import { demoNamespaceFor, isDemoEmail, withDemoSuffix } from "@/lib/demo";
import { notFound, redirect } from "next/navigation";
import YAML from "yaml";

import { DeployClient } from "./DeployClient";
import { UpdateValuesUnavailable } from "@/components/UpdateValuesUnavailable";
import type { UISpec } from "@/lib/ui-spec-to-zod";
import { decodeRouteParam, readReleaseForUpdate, updateDeployPath } from "@/lib/update-release";

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

  // This route cannot start an update (#296): it renders the template's
  // current version with no release values, so an update begun here — only
  // reachable by typing the URL — started from the ui-spec defaults and would
  // overwrite the release's Secrets with them. Send it to the version the
  // release runs, whose page loads its values.
  //
  // The target is built from what the API says about the release, never from
  // the query string alone: the id must be a UUID, and the release must belong
  // to this template, so the redirect cannot land on another template's page.
  if (updateReleaseId !== undefined) {
    const read = await readReleaseForUpdate(apiFetch, updateReleaseId, name);
    if (read.kind === "not-found") notFound();
    if (read.kind === "sign-in") {
      const here = `/catalog/${encodeURIComponent(decodeRouteParam(name))}/deploy?updateReleaseId=${encodeURIComponent(updateReleaseId)}`;
      redirect(`/?next=${encodeURIComponent(here)}`);
    }
    if (read.kind === "unavailable") {
      return <UpdateValuesUnavailable releaseId={updateReleaseId} />;
    }
    redirect(updateDeployPath(read.templateName, read.version, updateReleaseId));
  }

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
  // Only a new release gets here, and only a new release has a namespace field.
  const defaultName = isDemoEmail(me?.email) ? withDemoSuffix(name, true) : "";
  const demoNamespace = demoNamespaceFor(me?.email);

  // The terms switch's starting value comes from KubeTermsProvider in the
  // root shell (#39, #247).
  return (
    <DeployClient
      templateName={name}
      version={t.current_version}
      team={t.owning_team_name}
      spec={spec}
      defaultName={defaultName}
      demoNamespace={demoNamespace}
    />
  );
}
