import { getTranslations } from "next-intl/server";

import type { LoginErrorCode } from "@/lib/login-error";

const BODY_KEY: Record<LoginErrorCode, string> = {
  cancelled: "loginCancelled",
  expired: "sessionExpired",
  failed: "loginFailed",
};

/**
 * Shown when /api/auth/callback sent the user back instead of logging them in.
 * The point is the retry link: whatever went wrong, starting over is the only
 * thing the user can do about it.
 */
export async function LoginErrorBanner({ code }: { code: LoginErrorCode }) {
  const t = await getTranslations("auth");
  return (
    <div
      role="alert"
      className="w-full rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-left"
    >
      <p className="text-sm font-medium">{t("loginFailedTitle")}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t(BODY_KEY[code])}</p>
      <a href="/api/auth/login" className="mt-2 inline-block text-sm underline">
        {t("retryLogin")}
      </a>
    </div>
  );
}
