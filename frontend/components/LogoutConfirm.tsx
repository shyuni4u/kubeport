"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

// The button behind GET /api/auth/logout (#28). The actual logout is a POST,
// because a GET is something another site can cause and the route checks
// Origin to stop that — so the address-bar path ends here, at a thing the
// person has to press.
//
// Deliberately the same fetch + hard redirect the user menu uses rather than a
// <form method="post">: it sends the same-origin Origin header the route's
// CSRF check requires, and window.location.assign guarantees the whole tree
// re-renders without the session rather than leaving a stale shell behind.
export function LogoutConfirm() {
  const t = useTranslations("logout");
  const [pending, setPending] = useState(false);

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
      <div className="mt-6 flex justify-center gap-3">
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
              // router.push would keep the cached tree — including the shell
              // the server rendered with this user's email still in it. The
              // session is gone; the document has to be fetched again.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/");
            });
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
