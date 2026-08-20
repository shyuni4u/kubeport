import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";

type TemplateStatus = "draft" | "published" | "deprecated";

type TemplateVersion = {
  id: string;
  version: number;
  status: string;
  authoring_mode: string;
};

export default async function TemplateDetail({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const tr = await getTranslations("templates");
  const [tRes, vsRes, meRes] = await Promise.all([
    apiFetch(`/v1/templates/${name}`),
    apiFetch(`/v1/templates/${name}/versions`),
    apiFetch(`/v1/me`),
  ]);
  if (!tRes.ok) throw new Error(`템플릿 조회 실패: ${tRes.status} ${await tRes.text()}`);
  const t = await tRes.json();
  if (!vsRes.ok) throw new Error(`버전 조회 실패: ${vsRes.status} ${await vsRes.text()}`);
  const vs = await vsRes.json() as { versions?: TemplateVersion[] };
  const versions = vs.versions ?? [];
  const me = meRes.ok ? (await meRes.json() as { groups?: string[] }) : null;

  // Mirror backend ensureTemplateEditor so we don't render mutation UI a caller
  // can't use. Global templates (no owning_team_id) require kubeport-admin;
  // team templates need team editor membership — the backend is still the
  // source of truth, so we stay optimistic on team templates and rely on the
  // API's 403 to surface anything we missed.
  const isAdmin = me?.groups?.includes("kubeport-admin") ?? false;
  const isGlobalTemplate = !t.owning_team_id;
  const canEdit = isAdmin || !isGlobalTemplate;
  // Backend rejects POST /versions with 409 when a draft already exists.
  // Instead of surfacing the conflict, funnel the user to the existing draft.
  const existingDraft = versions.find((v) => v.status === "draft") ?? null;
  const latestVersion = versions.length > 0
    ? versions.reduce((a, b) => (a.version > b.version ? a : b))
    : null;

  async function publish(formData: FormData) {
    "use server";
    const version = formData.get("version") as string;
    const res = await apiFetch(`/v1/templates/${name}/versions/${version}/publish`, { method: "POST" });
    if (!res.ok) throw new Error(`publish 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/templates/${name}`);
  }

  async function deprecate(formData: FormData) {
    "use server";
    const version = formData.get("version") as string;
    const res = await apiFetch(`/v1/templates/${name}/versions/${version}/deprecate`, { method: "POST" });
    if (!res.ok) throw new Error(`deprecate 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/templates/${name}`);
  }

  async function undeprecate(formData: FormData) {
    "use server";
    const version = formData.get("version") as string;
    const res = await apiFetch(`/v1/templates/${name}/versions/${version}/undeprecate`, { method: "POST" });
    if (!res.ok) throw new Error(`undeprecate 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/templates/${name}`);
  }

  // Draft-only delete. Backend returns 204 on success, 409 for non-drafts
  // (defense-in-depth — the UI only renders this button for drafts anyway).
  async function deleteDraft(formData: FormData) {
    "use server";
    const version = formData.get("version") as string;
    const res = await apiFetch(`/v1/templates/${name}/versions/${version}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`draft 삭제 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/templates/${name}`);
  }

  // No pre-creation of drafts. "+ 새 버전" is a plain Link to the latest
  // version's edit page; the edit page's Save button POSTs a new version
  // only when the user actually saves. Going back without saving leaves the
  // DB untouched.

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{t.display_name}</h1>
          <p className="text-muted-foreground">{t.description}</p>
        </div>
        {canEdit && latestVersion && (
          existingDraft ? (
            <Link
              href={`/templates/${name}/versions/${existingDraft.version}/edit?mode=${existingDraft.authoring_mode}`}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
            >
              {tr("detail.editDraft", { version: existingDraft.version })}
            </Link>
          ) : (
            <Link
              href={`/templates/${name}/versions/${latestVersion.version}/edit?mode=${latestVersion.authoring_mode}`}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
            >
              {tr("detail.newVersion")}
            </Link>
          )
        )}
      </div>
      {!canEdit && (
        <p className="mt-2 text-xs text-muted-foreground">
          {isGlobalTemplate ? tr("detail.readOnlyGlobal") : tr("detail.readOnlyNoPerm")}
        </p>
      )}
      <h2 className="mt-6 font-semibold">{tr("detail.versionsHeading")}</h2>
      <ul className="space-y-2 mt-2">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center gap-3">
            <span>v{v.version}</span>
            <span
              title={tr(`statusHelp.${v.status as TemplateStatus}`)}
              className={`text-xs px-2 py-0.5 rounded ${
                v.status === "published" ? "bg-green-100 text-green-800"
                : v.status === "deprecated" ? "bg-muted text-foreground"
                : "bg-yellow-100 text-yellow-800"
              }`}
            >
              {tr(`status.${v.status as TemplateStatus}`)}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
              {v.authoring_mode === "yaml" ? "YAML" : "UI"}
            </span>
            {canEdit && (
              <>
                <Link
                  href={`/templates/${name}/versions/${v.version}/edit?mode=${v.authoring_mode}`}
                  className="text-primary text-sm"
                >
                  {tr("edit")}
                </Link>
                {v.status === "draft" && (
                  <>
                    <form action={publish}>
                      <input type="hidden" name="version" value={v.version} />
                      <ConfirmSubmit
                        message={tr("detail.confirmPublish", { version: v.version })}
                        className="text-primary text-sm"
                      >
                        {tr("publish")}
                      </ConfirmSubmit>
                    </form>
                    <form action={deleteDraft}>
                      <input type="hidden" name="version" value={v.version} />
                      <ConfirmSubmit
                        message={tr("detail.confirmDeleteDraft", { version: v.version })}
                        className="text-red-600 text-sm"
                      >
                        {tr("deleteDraft")}
                      </ConfirmSubmit>
                    </form>
                  </>
                )}
                {v.status === "published" && (
                  <form action={deprecate}>
                    <input type="hidden" name="version" value={v.version} />
                    <ConfirmSubmit
                      message={tr("detail.confirmDeprecate", { version: v.version })}
                      className="text-red-600 text-sm"
                    >
                      {tr("deprecate")}
                    </ConfirmSubmit>
                  </form>
                )}
                {v.status === "deprecated" && (
                  <form action={undeprecate}>
                    <input type="hidden" name="version" value={v.version} />
                    <button className="text-primary text-sm" title={tr("undeprecateHelp")}>
                      {tr("undeprecate")}
                    </button>
                  </form>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
