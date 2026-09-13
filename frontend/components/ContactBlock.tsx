"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/**
 * The copyable block that tells an admin which request, or which object, to
 * look at (#6): labelled lines and a copy button. Only values the screen
 * already shows go in — never a token, a cookie or a cluster address.
 */
export function ContactBlock({ facts }: { facts: ReadonlyArray<readonly [label: string, value: string]> }) {
  const t = useTranslations("problem");
  const [copied, setCopied] = useState(false);
  const text = facts
    .filter(([, value]) => value !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard (plain http, a denied permission): the block stays on
      // screen as selectable text.
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{t("contactTitle")}</span>
        <button
          type="button"
          onClick={copy}
          className="rounded border border-border bg-card px-2 py-0.5 text-xs hover:bg-hover"
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono">{text}</pre>
    </div>
  );
}
