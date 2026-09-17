import { TeamCreateForm } from "@/components/TeamForms";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { type ActionState } from "@/components/ActionForm";
import { isDemoEmail } from "@/lib/demo";
import { problemTitle } from "@/lib/problem";

// Localized inline error for a failed team mutation. Raw body goes to the
// server log only.
async function actionError(what: string, res: Response): Promise<ActionState> {
  const te = await getTranslations("admin.teams.errors");
  const body = await res.text();
  console.error(`[admin/teams] ${what} failed: ${res.status} ${body}`);
  // Demo admins hold kubeport-admin, so "only kubeport-admin can manage teams"
  // was wrong about them; the refusal is the demo gate (#180).
  if (res.status === 403) {
    return { error: problemTitle(body) === "demo-restricted" ? te("demoRestricted") : te("forbidden") };
  }
  if (res.status === 404) return { error: te("notFound") };
  if (res.status === 409) return { error: te("conflict") };
  return { error: te("generic", { status: res.status }) };
}

export default async function AdminTeamsPage() {
  const t = await getTranslations("admin.teams");
  const res = await apiFetch("/v1/teams");
  // Demo accounts can read teams but every mutation here is refused by the
  // demo gate, regardless of install settings — say so before they fill in a
  // form, not after (#180).
  const me = await apiFetch("/v1/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const isDemo = isDemoEmail(me?.email);
  // Bubbles to app/error.tsx; the body is deliberately not part of the message.
  if (!res.ok) throw new Error(`teams fetch failed: HTTP ${res.status}`);
  // Backend serializes pgtype.Text as a plain string (or null).
  const { teams } = await res.json() as { teams: Array<{ id: string; name: string; display_name: string | null }> };

  async function createTeam(_prev: ActionState, formData: FormData): Promise<ActionState> {
    "use server";
    const res = await apiFetch("/v1/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        display_name: formData.get("display_name"),
      }),
    });
    if (!res.ok) return actionError("create team", res);
    revalidatePath("/admin/teams");
    return {};
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold mb-4">{t("title")}</h1>
      {isDemo && (
        <p role="status" className="mb-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          {t("demoNotice")}
        </p>
      )}
      <TeamCreateForm action={createTeam} disabled={isDemo} />
      <h2 className="font-semibold">{t("listHeading")}</h2>
      {teams.length === 0 && <p className="rounded-[12px] border bg-card p-6 text-sm text-muted-foreground">{t("emptyTeams")}</p>}
      <ul className="space-y-2">
        {teams.map(t => (
          <li key={t.id} className="rounded-[12px] border bg-card p-4">
            <Link href={`/admin/teams/${t.id}`} className="font-medium text-link hover:underline">
              {t.display_name ?? t.name}
            </Link>
            <span className="text-xs text-muted-foreground ml-2">{t.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
