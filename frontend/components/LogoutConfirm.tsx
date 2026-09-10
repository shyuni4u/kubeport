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
//
// The cost of that choice is that logging out needs JavaScript. A form POST
// would not: but a navigation form POST's Origin header is not guaranteed
// across browsers, so accepting one would mean relaxing the route's
// "no Origin, no logout" rule — trading a working no-JS path for a weaker
// defence against the very thing the confirmation exists for.
export function LogoutConfirm() {
  const t = useTranslations("logout");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

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
            setPending(true);
            setFailed(false);
            // redirect: "manual" so the answer we read is the logout route's
            // own. The route replies 303 to "/", and the default "follow"
            // would fetch the landing page and hand us ITS status — making
            // "did the logout work?" depend on whether landing rendered, and
            // costing a page load we throw away because we navigate anyway.
            // Manual turns the 303 into an opaque redirect (type
            // "opaqueredirect", status 0); a refusal is not a redirect and
            // arrives intact as 403.
            void fetch("/api/auth/logout", { method: "POST", redirect: "manual" })
              .then((res) => {
                // Only leave on success. Navigating regardless — which is what
                // .finally did — showed a still-signed-in user the signed-out
                // landing page, and this screen exists precisely so someone
                // can be sure. A 403 here is a real configuration outcome:
                // allowedOrigins() comes from PUBLIC_ORIGIN/OIDC_REDIRECT_URI,
                // so a changed domain refuses every logout.
                const redirected = res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
                if (!res.ok && !redirected) throw new Error(String(res.status));
                // router.push would keep the cached tree — including the shell
                // the server rendered with this user's email still in it. The
                // session is gone; the document has to be fetched again.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.assign("/");
              })
              .catch(() => {
                setPending(false);
                setFailed(true);
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
