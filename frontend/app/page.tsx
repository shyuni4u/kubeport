import { getTranslations } from "next-intl/server";
import { LandingCompare } from "@/components/LandingCompare";
import { apiFetch } from "@/lib/api-server";
import { demoEnabled } from "@/lib/oidc";
import { loadShowcase } from "@/lib/showcase/load";

export default async function Home() {
  const t = await getTranslations("landing");
  const me = await apiFetch("/v1/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const demo = demoEnabled();
  const adminEmail = process.env.DEMO_ADMIN_EMAIL ?? "demo-admin@demo.kubeport";
  const userEmail = process.env.DEMO_USER_EMAIL ?? "demo-user@demo.kubeport";
  const passwordHint = process.env.DEMO_PASSWORD_HINT ?? "";
  const showcase = loadShowcase();

  return (
    <main className="mx-auto flex max-w-5xl flex-col items-center gap-10 px-4 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-3xl font-semibold">kubeport</h1>
        <p className="text-muted-foreground">{t("tagline")}</p>
      </div>

      <LandingCompare resourcesYaml={showcase.resourcesYaml} uiSpecYaml={showcase.uiSpecYaml} />

      {me ? (
        <a href="/catalog" className="rounded-md bg-primary px-4 py-2 text-primary-foreground">{t("goCatalog")}</a>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {demo && (
            <div className="flex gap-3">
              <a href={`/api/auth/login?provider=demo&hint=${encodeURIComponent(adminEmail)}`} className="rounded-md border px-4 py-2 hover:bg-accent">{t("tryAdmin")}</a>
              <a href={`/api/auth/login?provider=demo&hint=${encodeURIComponent(userEmail)}`} className="rounded-md border px-4 py-2 hover:bg-accent">{t("tryUser")}</a>
            </div>
          )}
          {demo && (
            <p className="text-xs text-muted-foreground">
              {t("demoNote")}
              {passwordHint && <><br />{t("demoCreds", { password: passwordHint })}</>}
            </p>
          )}
          <a href="/api/auth/login" className="text-sm underline">{t("loginPrimary")}</a>
        </div>
      )}
    </main>
  );
}
