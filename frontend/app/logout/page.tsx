import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { LogoutConfirm } from "@/components/LogoutConfirm";
import { getSession } from "@/lib/session";

// The confirmation screen behind GET /api/auth/logout (#28). Excluded from the
// proxy's session gate, because a logged-out visitor arriving here needs to be
// told they are already logged out — not bounced into a login flow to reach a
// page whose whole purpose is to end one.
export default async function LogoutPage() {
  const session = await getSession();
  const t = await getTranslations("logout");

  if (!session) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">{t("alreadyTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("alreadyBody")}</p>
        <Link href="/" className="mt-6 inline-block text-sm underline">
          {t("home")}
        </Link>
      </div>
    );
  }

  return <LogoutConfirm />;
}
