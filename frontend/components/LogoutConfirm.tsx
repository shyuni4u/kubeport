"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useLogout } from "@/lib/use-logout";

// The button behind GET /api/auth/logout (#28). The actual logout is a POST,
// because a GET is something another site can cause and the route checks
// Origin to stop that — so the address-bar path ends here, at a thing the
// person has to press.
//
// Deliberately the same fetch + hard redirect the user menu uses rather than a
// <form method="post">: it sends the same-origin Origin header the route's
// CSRF check requires, and window.location.assign guarantees the whole tree
// re-renders without the session rather than leaving a stale shell behind.
//
// The cost of that choice is that logging out needs JavaScript. A form POST
// would not: but a navigation form POST's Origin header is not guaranteed
// across browsers, so accepting one would mean relaxing the route's
// "no Origin, no logout" rule — trading a working no-JS path for a weaker
// defence against the very thing the confirmation exists for.
export function LogoutConfirm() {
  const t = useTranslations("logout");
  // The request and how its answer is read live in lib/logout.ts, shared with
  // the top-bar menu (#166): redirect "manual", an opaque redirect or 3xx is
  // success, and anything else keeps the reader here.
  const { pending, failed, logout } = useLogout();

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
      {failed && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t("failed")}
        </p>
      )}
      <div className="mt-6 flex justify-center gap-3">
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            // Only leaves on success. Navigating regardless showed a
            // still-signed-in user the signed-out landing page, and this
            // screen exists precisely so someone can be sure.
            void logout();
          }}
        >
          {pending ? t("pending") : t("confirm")}
        </Button>
        <Button type="button" variant="outline" disabled={pending} render={<a href="/catalog" />}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}
