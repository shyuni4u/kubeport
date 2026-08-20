import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";

export default async function AdminTeamsPage() {
  const t = await getTranslations("admin.teams");
  const res = await apiFetch("/v1/teams");
  if (!res.ok) throw new Error(`팀 조회 실패: ${res.status} ${await res.text()}`);
  // Backend serializes pgtype.Text as a plain string (or null).
  const { teams } = await res.json() as { teams: Array<{ id: string; name: string; display_name: string | null }> };

  async function createTeam(formData: FormData) {
    "use server";
    const res = await apiFetch("/v1/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        display_name: formData.get("display_name"),
      }),
    });
    if (!res.ok) throw new Error(`팀 생성 실패: ${res.status} ${await res.text()}`);
    revalidatePath("/admin/teams");
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">{t("title")}</h1>
      <form action={createTeam} className="flex gap-2 mb-6">
        <label htmlFor="team-name" className="sr-only">{t("slugLabel")}</label>
        <input id="team-name" name="name" placeholder={t("slugPlaceholder")} className="border rounded px-3 py-1.5" required />
        <label htmlFor="team-display-name" className="sr-only">{t("displayNameLabel")}</label>
        <input id="team-display-name" name="display_name" placeholder={t("displayNamePlaceholder")} className="border rounded px-3 py-1.5" />
        <button className="px-4 py-1.5 bg-primary text-primary-foreground rounded">{t("createButton")}</button>
      </form>
      <ul className="space-y-2">
        {teams.map(t => (
          <li key={t.id}>
            <Link href={`/admin/teams/${t.id}`} className="text-primary">
              {t.display_name ?? t.name}
            </Link>
            <span className="text-xs text-muted-foreground ml-2">{t.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
