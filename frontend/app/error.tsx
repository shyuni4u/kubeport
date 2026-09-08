"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

// Global error boundary. Next.js hides server error messages in production,
// so the user would otherwise see an unstyled "Application error" screen.
// We show a plain-language notice and a retry (re-renders the segment).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");
  useEffect(() => {
    // Keep the technical detail in the console for whoever is debugging.
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-bold">{t("genericTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("genericBody")}</p>
      <Button type="button" className="mt-6" onClick={() => reset()}>
        {t("retry")}
      </Button>
    </div>
  );
}
