import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { ActionForm, type ActionState } from "@/components/ActionForm";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { HelpHint } from "@/components/HelpHint";
import { isDemoEmail } from "@/lib/demo";
import { problemTitle } from "@/lib/problem";

// Localized inline error for a failed member mutation. Raw body goes to the
// server log only.
async function actionError(what: string, res: Response): Promise<ActionState> {
  const te = await getTranslations("admin.teams.errors");
  const body = await res.text();
  console.error(`[admin/teams] ${what} failed: ${res.status} ${body}`);
  // Demo admins hold kubeport-admin; the refusal is the demo gate (#180).
  if (res.status === 403) {
    return { error: problemTitle(body) === "demo-restricted" ? te("demoRestricted") : te("forbidden") };
  }
  if (res.status === 404) return { error: te("notFound") };
  if (res.status === 409) return { error: te("conflict") };
  return { error: te("generic", { status: res.status }) };
}

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("admin.teams");
  const [membersRes, teamsRes, meRes] = await Promise.all([
    apiFetch(`/v1/teams/${id}/members`),
    apiFetch(`/v1/teams`),
    apiFetch("/v1/me"),
  ]);
  // Every member change here is refused for demo accounts by the demo gate,
  // whatever the install allows — say so up front (#180).
  const me = meRes.ok ? ((await meRes.json()) as { email?: string }) : null;
  const isDemo = isDemoEmail(me?.email);
  // Unknown team → global not-found page; other failures bubble to
  // app/error.tsx without the backend body in the message.
  if (membersRes.status === 404) notFound();
  if (!membersRes.ok) throw new Error(`team members fetch failed: HTTP ${membersRes.status}`);
  if (!teamsRes.ok) throw new Error(`teams fetch failed: HTTP ${teamsRes.status}`);
  // Backend serializes pgtype.Text as a plain string (or null), not the
  // {String, Valid} envelope an earlier version of this type assumed.
  const { members } = await membersRes.json() as {
    members: Array<{ user_id: string; role: string; email: string | null; user_display_name: string | null }> | null;
  };
  const { teams } = await teamsRes.json() as { teams: Array<{ id: string; name: string }> };
  const team = teams.find(t => t.id === id);

  async function addMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
    "use server";
    const res = await apiFetch(`/v1/teams/${id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email"),
        role: formData.get("role"),
      }),
    });
    if (!res.ok) return actionError("add member", res);
    revalidatePath(`/admin/teams/${id}`);
    return {};
  }

  async function removeMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
    "use server";
    const uid = formData.get("user_id");
    const res = await apiFetch(`/v1/teams/${id}/members/${uid}`, { method: "DELETE" });
    if (!res.ok) return actionError("remove member", res);
    revalidatePath(`/admin/teams/${id}`);
    return {};
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">{team?.name ?? id}</h1>
      {isDemo && (
        <p role="status" className="mb-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          {t("demoNotice")}
        </p>
      )}

      <h2 className="font-semibold mb-2">{t("membersHeading")}</h2>
      <table className="w-full bg-card border rounded text-sm mb-6">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="p-2 text-left">{t("colEmail")}</th><th className="p-2 text-left">{t("colRole")}</th><th className="p-2"></th></tr>
        </thead>
        <tbody>
          {(members ?? []).map(m => (
            <tr key={m.user_id} className="border-t">
              <td className="p-2">{m.email ?? m.user_id}</td>
              <td className="p-2">{m.role}</td>
              <td className="p-2">
                <ActionForm action={removeMember}>
                  <input type="hidden" name="user_id" value={m.user_id} />
                  <ConfirmSubmit
                    message={t("confirmRemoveMember", { email: m.email ?? m.user_id })}
                    className="text-red-600 dark:text-red-400 text-sm"
                  >
                    {t("removeMember")}
                  </ConfirmSubmit>
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold mb-2">{t("addMemberHeading")}</h2>
      <ActionForm action={addMember} className="flex flex-wrap gap-2">
        <label htmlFor="member-email" className="sr-only">{t("emailLabel")}</label>
        <input id="member-email" name="email" type="email" placeholder={t("emailPlaceholder")} required className="border rounded px-3 py-1.5" />
        <label htmlFor="member-role" className="sr-only">{t("roleLabel")}</label>
        <select id="member-role" name="role" className="border rounded px-3 py-1.5">
          <option value="editor">{t("roleEditor")}</option>
          <option value="viewer">{t("roleViewer")}</option>
        </select>
        <HelpHint text={t("roleHelp")} />
        <button className="px-4 py-1.5 bg-primary text-primary-foreground rounded">{t("addMemberButton")}</button>
      </ActionForm>
      <p className="text-xs text-muted-foreground mt-2">{t("loginHint")}</p>
    </div>
  );
}
