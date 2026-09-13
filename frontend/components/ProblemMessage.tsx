"use client";

import { useTranslations } from "next-intl";
import { parseProblemBody, problemParts } from "@/lib/error-detail";
import { ContactBlock } from "./ContactBlock";
import { useErrorDetail } from "./ErrorDetailProvider";

/**
 * A refused request as a screen keeps it until it renders ProblemMessage (#6):
 * the sentence the screen picked, the response as the API sent it, and when.
 * `omitDetail` is set when the sentence already quotes the server's message —
 * a validation failure the author has to read — so it is not shown twice.
 */
export type RequestFailure = {
  message: string;
  status: number;
  body: string;
  at: string;
  omitDetail?: boolean;
};

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
  omitDetail = false,
  context = [],
}: {
  message: string;
  status: number;
  body?: string;
  /** When the request failed, as an ISO string (fixed at failure, not at render). */
  at: string;
  /** The sentence already quotes the server's message; do not repeat it. */
  omitDetail?: boolean;
  /** Labelled values the screen already shows: cluster, namespace, release… */
  context?: ReadonlyArray<readonly [label: string, value: string]>;
}) {
  const t = useTranslations("problem");
  const { level } = useErrorDetail();
  const problem = parseProblemBody(body);
  const parts = problemParts(level, status, problem);
  const detail = omitDetail ? undefined : parts.detail;

  const facts: Array<readonly [string, string]> = [
    ...(problem?.requestId ? [[t("requestId"), problem.requestId] as const] : []),
    [t("time"), at],
    ...(status > 0 ? [[t("status"), problem?.title ? `${status} ${problem.title}` : String(status)] as const] : []),
    ...context,
  ];

  return (
    <div role="alert" className="flex flex-col gap-2 text-sm text-red-700 dark:text-red-400">
      <p className="whitespace-pre-wrap">{message}</p>

      {parts.kind && problem && (
        <details open={parts.open} className="rounded-md border border-border bg-card px-3 py-2 text-foreground">
          <summary className="cursor-pointer text-xs font-medium">{t("more")}</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("kind")}</dt>
            <dd className="font-mono">{`${status} ${problem.title}`}</dd>
            {detail && (
              <>
                <dt className="text-muted-foreground">{t("detail")}</dt>
                <dd className="whitespace-pre-wrap break-words font-mono">{detail}</dd>
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

      <ContactBlock facts={facts} />
    </div>
  );
}
