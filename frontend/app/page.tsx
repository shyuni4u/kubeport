import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LandingCompare } from "@/components/LandingCompare";
import { LoginErrorBanner } from "@/components/LoginErrorBanner";
import { apiFetch } from "@/lib/api-server";
import { parseLoginError } from "@/lib/login-error";
import { demoEnabled } from "@/lib/oidc";
import { sanitizeNext } from "@/lib/safe-next";
import { loadShowcase } from "@/lib/showcase/load";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ login_error?: string; next?: string }>;
}) {
  const t = await getTranslations("landing");
  const params = await searchParams;
  // Set by /api/auth/callback when a login attempt didn't finish.
  const loginError = parseLoginError(params.login_error);
  // Set by the proxy when it turned an unauthenticated page request away.
  const next = sanitizeNext(params.next);
  const me = await apiFetch("/v1/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const demo = demoEnabled();

  // The proxy only routes through here when a demo IdP is configured, because
  // that is the only case with a choice to show. If the configuration changed
  // between the redirect and this render, don't strand the visitor on a page
  // whose buttons are gone — send them on to the IdP the proxy would have
  // picked. Signed-in visitors fall through: they get "go to the catalog".
  if (next && !demo && !me) {
    redirect(`/api/auth/login?next=${encodeURIComponent(next)}`);
  }

  // Preserve where they were headed across the login round trip.
  const withNext = (href: string) =>
    next ? `${href}${href.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : href;
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

      {loginError && <LoginErrorBanner code={loginError} />}

      {/* Says why they are here rather than where they asked to go. Without
          it the redirect reads as the app losing the link. */}
      {next && !me && !loginError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loginRequired")}
        </p>
      )}

      <LandingCompare resourcesYaml={showcase.resourcesYaml} uiSpecYaml={showcase.uiSpecYaml} />

      {/* Signed in already — if they arrived carrying a destination (logged in
          on another tab while this one sat on landing), honour it. */}
      {me ? (
        <a href={next ?? "/catalog"} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">{next ? t("goBack") : t("goCatalog")}</a>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {demo && (
            <div className="flex gap-3">
              <a href={withNext(`/api/auth/login?provider=demo&hint=${encodeURIComponent(adminEmail)}`)} className="rounded-md border px-4 py-2 hover:bg-hover">{t("tryAdmin")}</a>
              <a href={withNext(`/api/auth/login?provider=demo&hint=${encodeURIComponent(userEmail)}`)} className="rounded-md border px-4 py-2 hover:bg-hover">{t("tryUser")}</a>
            </div>
          )}
          {demo && (
            <p className="text-xs text-muted-foreground">
              {t("demoNote")}
              {passwordHint && <><br />{t("demoCreds", { password: passwordHint })}</>}
            </p>
          )}
          {/* Primary CTA when demo is off (it's the only way in); secondary under the demo buttons. */}
          <a
            href={withNext("/api/auth/login")}
            className={demo ? "text-sm underline" : "rounded-md bg-primary px-4 py-2 text-primary-foreground"}
          >
            {t("loginPrimary")}
          </a>
        </div>
      )}
    </main>
  );
}
