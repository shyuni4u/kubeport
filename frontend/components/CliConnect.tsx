"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export function CliConnect() {
  const t = useTranslations("cli");
  const locale = useLocale();
  const [credential, setCredential] = useState<{ token: string; expires_at: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  async function issue() {
    setPending(true);
    setError(false);
    setCopied(false);
    setCredential(null);
    try {
      const response = await fetch("/api/auth/cli-token", { method: "POST", redirect: "error" });
      if (!response.ok) throw new Error("issuance failed");
      setCredential(await response.json());
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto max-w-xl space-y-5 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <Badge variant="warning">Beta</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <p className="text-sm">{t("permissions")}</p>
      <Button onClick={() => void issue()} disabled={pending}>
        {pending ? t("pending") : t("issue")}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{t("failed")}</p>}
      {credential && (
        <div className="space-y-3 rounded-lg border p-4">
          <Label htmlFor="cli-token">{t("token")}</Label>
          <Input id="cli-token" type="password" readOnly value={credential.token}
            autoComplete="off" onFocus={(event) => event.target.select()} />
          <p className="text-sm text-muted-foreground">
            {t("expires", { time: new Date(credential.expires_at).toLocaleString(locale) })}
          </p>
          <p className="text-sm">{t("paste")}</p>
          <Button variant="outline" onClick={async () => {
            try {
              await navigator.clipboard.writeText(credential.token);
              setCopied(true);
            } catch {
              setError(true);
            }
          }}>{copied ? t("copied") : t("copy")}</Button>
          <span role="status" className="sr-only">{copied ? t("copied") : ""}</span>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{t("revoke")}</p>
    </section>
  );
}
