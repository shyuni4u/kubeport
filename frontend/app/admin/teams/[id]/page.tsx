import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("admin.teams");
  const [membersRes, teamsRes] = await Promise.all([
    apiFetch(`/v1/teams/${id}/members`),
    apiFetch(`/v1/teams`),
  ]);
  if (!membersRes.ok) throw new Error(await membersRes.text());
  if (!teamsRes.ok) throw new Error(await teamsRes.text());
  // Backend serializes pgtype.Text as a plain string (or null), not the
  // {String, Valid} envelope an earlier version of this type assumed.
  const { members } = await membersRes.json() as {
    members: Array<{ user_id: string; role: string; email: string | null; user_display_name: string | null }> | null;
  };
  const { teams } = await teamsRes.json() as { teams: Array<{ id: string; name: string }> };
  const team = teams.find(t => t.id === id);

  async function addMember(formData: FormData) {
    "use server";
    const res = await apiFetch(`/v1/teams/${id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email"),
        role: formData.get("role"),
      }),
    });
    if (!res.ok) throw new Error(`멤버 추가 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/admin/teams/${id}`);
  }

  async function removeMember(formData: FormData) {
    "use server";
    const uid = formData.get("user_id");
    const res = await apiFetch(`/v1/teams/${id}/members/${uid}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`멤버 삭제 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/admin/teams/${id}`);
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">{team?.name ?? id}</h1>

      <h2 className="font-semibold mb-2">{t("membersHeading")}</h2>
      <table className="w-full bg-white border rounded text-sm mb-6">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="p-2 text-left">{t("colEmail")}</th><th className="p-2 text-left">{t("colRole")}</th><th className="p-2"></th></tr>
        </thead>
        <tbody>
          {(members ?? []).map(m => (
            <tr key={m.user_id} className="border-t">
              <td className="p-2">{m.email ?? m.user_id}</td>
              <td className="p-2">{m.role}</td>
              <td className="p-2">
                <form action={removeMember}>
                  <input type="hidden" name="user_id" value={m.user_id} />
                  <button className="text-red-600 text-sm">{t("removeMember")}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold mb-2">{t("addMemberHeading")}</h2>
      <form action={addMember} className="flex gap-2">
        <label htmlFor="member-email" className="sr-only">{t("emailLabel")}</label>
        <input id="member-email" name="email" type="email" placeholder={t("emailPlaceholder")} required className="border rounded px-3 py-1.5" />
        <label htmlFor="member-role" className="sr-only">{t("roleLabel")}</label>
        <select id="member-role" name="role" className="border rounded px-3 py-1.5">
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
        <button className="px-4 py-1.5 bg-primary text-primary-foreground rounded">{t("addMemberButton")}</button>
      </form>
      <p className="text-xs text-muted-foreground mt-2">{t("loginHint")}</p>
    </div>
  );
}
