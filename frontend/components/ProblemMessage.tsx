"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { parseProblemBody, problemParts } from "@/lib/error-detail";
import { useErrorDetail } from "./ErrorDetailProvider";

/**
 * A refused request, shown at the viewer's error detail level (#6).
 *
 * `message` is the screen's own sentence and is always shown. `body` is the
 * response body exactly as the API sent it; whatever this unfolds comes from
 * there and nowhere else, so no level shows what the server withheld. The
 * JSON envelope is never printed: the kind and status are labelled fields and
 * the server's message is a line of text (the 2026-09-09 note on #6).
 *
 * The block under the sentence is what an admin needs to find the request —
 * its id, when, and where — with a copy button, at every level.
 */
export function ProblemMessage({
  message,
  status,
  body,
  at,
  context = [],
}: {
  message: string;
  status: number;
  body?: string;
  /** When the request failed, as an ISO string (fixed at failure, not at render). */
  at: string;
  /** Labelled values the screen already shows: cluster, namespace, release… */
  context?: ReadonlyArray<readonly [label: string, value: string]>;
}) {
  const t = useTranslations("problem");
  const { level } = useErrorDetail();
  const problem = parseProblemBody(body);
  const parts = problemParts(level, status, problem);
  const [copied, setCopied] = useState(false);

  const facts: Array<readonly [string, string]> = [
    ...(problem?.requestId ? [[t("requestId"), problem.requestId] as const] : []),
    [t("time"), at],
    ...(status > 0 ? [[t("status"), problem?.title ? `${status} ${problem.title}` : String(status)] as const] : []),
    ...context.filter(([, value]) => value !== ""),
  ];
  const copyText = facts.map(([label, value]) => `${label}: ${value}`).join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
    } catch {
      // No clipboard (plain http, a denied permission): the block stays on
      // screen as selectable text.
    }
  }

  return (
    <div role="alert" className="flex flex-col gap-2 text-sm text-red-700 dark:text-red-400">
      <p className="whitespace-pre-wrap">{message}</p>

      {parts.kind && problem && (
        <details open={parts.open} className="rounded-md border border-border bg-card px-3 py-2 text-foreground">
          <summary className="cursor-pointer text-xs font-medium">{t("more")}</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("kind")}</dt>
            <dd className="font-mono">{`${status} ${problem.title}`}</dd>
            {parts.detail && (
              <>
                <dt className="text-muted-foreground">{t("detail")}</dt>
                <dd className="whitespace-pre-wrap break-words font-mono">{parts.detail}</dd>
              </>
            )}
            {parts.extensions && (
              <>
                <dt className="text-muted-foreground">{t("extensions")}</dt>
                <dd>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono">
                    {JSON.stringify(parts.extensions, null, 2)}
                  </pre>
                </dd>
              </>
            )}
          </dl>
          {level === "raw" && status >= 500 && (
            <p className="mt-2 text-xs text-muted-foreground">{t("logsHint")}</p>
          )}
        </details>
      )}

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
        <pre className="whitespace-pre-wrap break-words font-mono">{copyText}</pre>
      </div>
    </div>
  );
}
