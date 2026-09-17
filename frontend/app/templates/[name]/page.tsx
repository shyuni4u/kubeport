import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { apiPathSegment, versionSegment } from "@/lib/api-path";
import { ActionForm, type ActionState } from "@/components/ActionForm";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { problemTitle } from "@/lib/problem";

type TemplateStatus = "draft" | "published" | "deprecated";

type TemplateVersion = {
  id: string;
  version: number;
  status: string;
  authoring_mode: string;
};

// Turn a failed backend response into the inline error state rendered by
// ActionForm. The raw body is logged server-side only — the user sees a
// localized sentence keyed by status.
async function actionError(what: string, res: Response): Promise<ActionState> {
  const te = await getTranslations("templates.detail.errors");
  const body = await res.text();
  console.error(`[templates] ${what} failed: ${res.status} ${body}`);
  // A demo admin acting on a template the demo did not create is refused as
  // `demo-restricted`, not for lacking the admin group it does have (#180).
  // Publishing a version and switching a published one on or off are refused
  // to demo accounts on any template (#294).
  if (res.status === 403) {
    if (problemTitle(body) !== "demo-restricted") return { error: te("forbidden") };
    const publishing = what === "publish" || what === "deprecate" || what === "undeprecate";
    return { error: publishing ? te("demoPublishRestricted") : te("demoRestricted") };
  }
  if (res.status === 409) return { error: te("conflict") };
  return { error: te("generic", { status: res.status }) };
}

// A version field that is not a positive integer never reaches the API (#374).
// The page only renders real versions, so this answers a hand-made post.
async function badVersion(what: string): Promise<ActionState> {
  const te = await getTranslations("templates.detail.errors");
  console.error(`[templates] ${what} refused: version is not a positive integer`);
  return { error: te("generic", { status: 400 }) };
}

export default async function TemplateDetail({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  // The param arrives decoded, so `%2F`·`%2e%2e` in the URL are `/`·`..` here
  // and would walk every API call below onto another /v1 route (#374).
  const seg = apiPathSegment(name);
  if (seg === null) notFound();
  const tr = await getTranslations("templates");
  const [tRes, vsRes, meRes] = await Promise.all([
    apiFetch(`/v1/templates/${seg}`),
    apiFetch(`/v1/templates/${seg}/versions`),
    apiFetch(`/v1/me`),
  ]);
  // 404 covers both "no such template" and "not visible to this caller" —
  // the global not-found page words it that way. Anything else bubbles to
  // app/error.tsx; keep the body out of the message (it's shown nowhere in
  // production anyway, but avoid it leaking into dev overlays/logs twice).
  if (tRes.status === 404) notFound();
  if (!tRes.ok) throw new Error(`template fetch failed: HTTP ${tRes.status}`);
  const t = await tRes.json();
  if (!vsRes.ok) throw new Error(`template versions fetch failed: HTTP ${vsRes.status}`);
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

  // Each action returns ActionState (rendered inline by ActionForm) instead
  // of throwing — a thrown server-action error is replaced by a generic
  // crash screen in production, hiding the actual 403/409 from the admin.
  async function publish(_prev: ActionState, formData: FormData): Promise<ActionState> {
    "use server";
    const version = versionSegment(formData.get("version"));
    if (version === null) return badVersion("publish");
    const res = await apiFetch(`/v1/templates/${seg}/versions/${version}/publish`, { method: "POST" });
    if (!res.ok) return actionError("publish", res);
    revalidatePath(`/templates/${name}`);
    return {};
  }

  async function deprecate(_prev: ActionState, formData: FormData): Promise<ActionState> {
    "use server";
    const version = versionSegment(formData.get("version"));
    if (version === null) return badVersion("deprecate");
    const res = await apiFetch(`/v1/templates/${seg}/versions/${version}/deprecate`, { method: "POST" });
    if (!res.ok) return actionError("deprecate", res);
    revalidatePath(`/templates/${name}`);
    return {};
  }

  async function undeprecate(_prev: ActionState, formData: FormData): Promise<ActionState> {
    "use server";
    const version = versionSegment(formData.get("version"));
    if (version === null) return badVersion("undeprecate");
    const res = await apiFetch(`/v1/templates/${seg}/versions/${version}/undeprecate`, { method: "POST" });
    if (!res.ok) return actionError("undeprecate", res);
    revalidatePath(`/templates/${name}`);
    return {};
  }

  // Draft-only delete. Backend returns 204 on success, 409 for non-drafts
  // (defense-in-depth — the UI only renders this button for drafts anyway).
  async function deleteDraft(_prev: ActionState, formData: FormData): Promise<ActionState> {
    "use server";
    const version = versionSegment(formData.get("version"));
    if (version === null) return badVersion("delete draft");
    const res = await apiFetch(`/v1/templates/${seg}/versions/${version}`, { method: "DELETE" });
    if (!res.ok) return actionError("delete draft", res);
    revalidatePath(`/templates/${name}`);
    return {};
  }

  // No pre-creation of drafts. "+ 새 버전" is a plain Link to the latest
  // version's edit page; the edit page's Save button POSTs a new version
  // only when the user actually saves. Going back without saving leaves the
  // DB untouched.

  return (
    <div className="space-y-6">
      <Link href="/templates" className="text-sm text-link hover:underline">{tr("detail.backToTemplates")}</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t.display_name || t.name}</h1>
          <p className="text-muted-foreground">{t.description}</p>
        </div>
        {canEdit && latestVersion && (
          existingDraft ? (
            <Link
              href={`/templates/${name}/versions/${existingDraft.version}/edit?mode=${existingDraft.authoring_mode}`}
              className={buttonVariants()}
            >
              {tr("detail.editDraft", { version: existingDraft.version })}
            </Link>
          ) : (
            <Link
              href={`/templates/${name}/versions/${latestVersion.version}/edit?mode=${latestVersion.authoring_mode}`}
              className={buttonVariants()}
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
          <li key={v.id} className="flex flex-wrap items-center gap-3 rounded-[12px] border bg-card p-4">
            <span className="min-w-12 font-semibold">v{v.version}</span>
            <span
              title={tr(`statusHelp.${v.status as TemplateStatus}`)}
              className={`text-xs px-2 py-0.5 rounded ${
                v.status === "published" ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200"
                : v.status === "deprecated" ? "bg-muted text-foreground"
                : "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200"
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
                  className={buttonVariants({ variant: "outline" })}
                >
                  {tr("edit")}
                </Link>
                {v.status === "draft" && (
                  <>
                    <ActionForm action={publish}>
                      <input type="hidden" name="version" value={v.version} />
                      <ConfirmSubmit
                        message={tr("detail.confirmPublish", { version: v.version })}
                        className={buttonVariants({ variant: "outline" })}
                      >
                        {tr("publish")}
                      </ConfirmSubmit>
                    </ActionForm>
                    <ActionForm action={deleteDraft}>
                      <input type="hidden" name="version" value={v.version} />
                      <ConfirmSubmit
                        message={tr("detail.confirmDeleteDraft", { version: v.version })}
                        variant="destructive"
                      >
                        {tr("deleteDraft")}
                      </ConfirmSubmit>
                    </ActionForm>
                  </>
                )}
                {v.status === "published" && (
                  <ActionForm action={deprecate}>
                    <input type="hidden" name="version" value={v.version} />
                    <ConfirmSubmit
                      message={tr("detail.confirmDeprecate", { version: v.version })}
                      variant="destructive"
                    >
                      {tr("deprecate")}
                    </ConfirmSubmit>
                  </ActionForm>
                )}
                {v.status === "deprecated" && (
                  <ActionForm action={undeprecate}>
                    <input type="hidden" name="version" value={v.version} />
                    <button className={buttonVariants({ variant: "outline" })} title={tr("undeprecateHelp")}>
                      {tr("undeprecate")}
                    </button>
                  </ActionForm>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
